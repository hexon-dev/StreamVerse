'use strict';
/**
 * StreamVerse Studios — AI Director & Writer Engine
 *
 * Agnes AI (agnes-2.5-flash) acts as a genuine auteur director. Every decision — framing, light,
 * pacing, colour, performance — exists to serve THEME and EMOTION, not just
 * plot mechanics. The output must read like it came from a person who has
 * watched 10,000 films and knows exactly why each shot works.
 *
 * ── Cast-First Architecture ──
 * Before any episode is written, the pipeline calls writeSeriesSummary() to
 * simulate the entire show internally, then writeCastBible() to generate and
 * lock every character with: visual metadata + seed, Deepgram voice ID, and
 * a permanent visual anchor. Characters are the foundational layer — episodes
 * reference locked cast metadata, never re-derive identity.
 */
// SOURCE-OF-TRUTH CONTRACT: this file contains the production implementation.
// It must not be rewritten by startup migrations or runtime text transforms.

const axios  = require('axios');
const config = require('./config');
const { safeJsonParse } = require('./util');
const globalContinuity = require('./globalContinuity');
const db = require('./db');
const shotStaging = require('./shotStaging');
const directorialOrchestrator = require('./directorialOrchestrator');

// ─────────────────────────────────────────────────────────────────────────────
// Deepgram Aura voice pools — human-like, expressive voices
// Assigned at cast creation and locked per-character for all episodes.
// ─────────────────────────────────────────────────────────────────────────────
const FEMALE_VOICES = [
  'aura-athena-en',    // clear, articulate, professional — best for leads
  'aura-stella-en',    // bright, expressive, emotive
  'aura-luna-en',      // soft, intimate, warm — good for quiet/internal moments
  'aura-hera-en',      // confident, authoritative — good for antagonists
];
const MALE_VOICES = [
  'aura-helios-en',    // clear, warm, conversational — best for leads
  'aura-orion-en',     // deep, calm, trustworthy
  'aura-arcas-en',     // natural, smooth, neutral
  'aura-zeus-en',      // deep, authoritative — good for antagonists/authority
];

/**
 * Derive a stable integer hash from a string (character name).
 * Used for both voice selection and image generation seed.
 */
function _nameHash(name) {
  if (!name) return 0;
  let h = 5381;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) + h) ^ name.charCodeAt(i);
    h = h >>> 0;
  }
  return h;
}

/**
 * Assign a deterministic Deepgram voice ID to a character based on gender + name hash.
 * Same character → same voice across all episodes. Different characters → different voices.
 */
function assignVoiceForCharacter(character) {
  const gender = (character.gender || character.visual_profile?.gender || '').toLowerCase();
  const pool = gender === 'male' ? MALE_VOICES
             : gender === 'female' ? FEMALE_VOICES
             : FEMALE_VOICES;
  const idx = _nameHash(character.name) % pool.length;
  return pool[idx];
}

/**
 * Derive a deterministic image generation seed for a character.
 * The seed is what makes the CF worker produce the exact same person every time.
 */
function assignSeedForCharacter(character) {
  return _nameHash(character.name) % 9999999;
}

/**
 * Derive a deterministic shot-level seed from episode + scene + shot indices.
 * Used for non-character shots (environments, inserts) so the same shot
 * description produces a consistent image across retries.
 */
function assignShotSeed(episodeNumber, sceneNumber, shotIndex) {
  return ((episodeNumber * 1000 + sceneNumber) * 100 + shotIndex) % 9999999;
}

// ─────────────────────────────────────────────────────────────────────────────
// FFmpeg Effects & Tools Catalog — injected into every script prompt so the
// LLM knows exactly which cinematic effects, transitions, and layouts it can
// request. The pipeline maps these names directly to the FFmpeg service.
// ─────────────────────────────────────────────────────────────────────────────
// The active video backend name is read once at startup from config.videoProvider
// (LTX by default; Magic Hour only when VIDEO_PROVIDER=magichour) so this prompt
// text always matches whichever model is actually generating the clips.
const _VIDEO_BACKEND_NAME =
  config.videoProvider === 'magichour' ? 'Magic Hour' : 'LTX';


const IS_AGNES_PROVIDER = String(config.videoProvider || '').toLowerCase() === 'agnes';

// Agnes is strongest when it is allowed to behave like a live-action scene
// performer: several people can share one shot, listen, interrupt, react and
// continue the same physical action. Keep the rule provider-aware so LTX's
// existing one-speaker constraints remain intact where they are required.
const AGNES_CONVERSATIONAL_RULES = `
═══ AGNES CONVERSATIONAL CINEMA MODE ═══

The selected video provider is AGNES. Write scenes like an actual live-action movie,
not a collection of isolated talking heads.

1. MULTI-CHARACTER DIALOGUE IS A FIRST-CLASS BEAT.
   - When two or more characters are physically together and the dramatic situation supports it,
     keep them in the SAME SHOT and let them exchange multiple short turns in chronological order.
   - Prefer 2-4 conversational turns in a shared shot over unnecessarily splitting the exchange.
   - The listening characters must visibly react while another character speaks: eye contact, breath,
     posture changes, glances, hesitation, interruptions, defensive gestures, or movement through space.
   - Each spoken line must identify the exact speaker. Do not use narrator voice to connect the exchange.

2. CONVERSATION MUST BE DRAMATICALLY NECESSARY.
   - Every line should reveal information, change power, expose emotion, create a question, challenge a claim,
     answer something, interrupt someone, or force a decision.
   - Avoid greetings, exposition dumps, filler, repeated statements, and robotic one-line exchanges.
   - Characters should sound like they know each other and are reacting to the exact thing just said.

3. SHARED SHOT GEOGRAPHY.
   - Every visible speaker and listener stays in a stable screen position unless the action itself moves them.
   - A speaker can cross the room, approach, leave, sit, stand, enter or exit — but those movements must be
     described as physical action occurring during the shot, not as an unexplained new pose.

4. SPEECH + ACTION ARE ONE PERFORMANCE.
   - Do not freeze characters while they talk.
   - Let the body performance continue underneath speech: walking, opening a door, searching a file, driving,
     looking through a window, turning toward another person, stopping, reaching, or changing position.
   - Keep exact quoted words as the only spoken audio. Actions and delivery guidance remain unquoted.

5. NO CAPTIONS, NO NARRATOR, NO INVENTED SPEECH.
   - Never add subtitles, captions, title cards or explanatory narration.
   - Preserve authored dialogue when it exists. Semantically rewrite only when needed to remove duplication or
     convert a stage direction into natural spoken wording without changing the intended dramatic beat.
`;

const TRAVEL_CONTINUITY_RULES = `
═══ SEMANTIC TRAVEL / LOCATION CONTINUITY CONTRACT ═══

A location change is a physical story event, not a data-field change.
Characters NEVER teleport from an origin to a destination simply because the next
scene has a different location.

For every meaningful location change, reason about this chain:
ORIGIN → DEPARTURE → TRANSIT / ROUTE → ARRIVAL → DESTINATION STATE.

1. DEPARTURE
   Show the character deciding to leave, starting the trip, stepping out, starting the car,
   opening the train door, leaving the room, or otherwise beginning movement.

2. TRANSIT
   When the journey matters narratively, allocate one or more shots to the actual movement:
   walking through a corridor, crossing a street, driving, riding, entering a vehicle, passing
   landmarks, moving through a doorway, climbing stairs, or approaching the destination.
   A travel beat must change the character's position over time.

3. ARRIVAL
   The destination is not the opening state of a travel shot unless that shot is explicitly an
   arrival/reveal shot. The final travel shot should end with the character approaching, entering,
   stopping, parking, stepping out, or otherwise arriving before the destination scene takes over.

4. SPATIAL CAUSALITY
   Every transition must identify the origin, destination, travel mode, visible route beat and the
   physical state at the beginning and end. Preserve wardrobe, props, weather, lighting logic and
   character emotional state during the journey unless the story explicitly changes them.

5. DO NOT 'SOLVE' TRAVEL WITH A STATIC CUT.
   Do not write 'arrives at the hospital' as the only movement beat when the story requires the journey.
   Write what the audience actually sees happen before the arrival.

6. SAME LOCATION IS NOT TRAVEL.
   Walking across a room is an action inside the same location. Crossing to another location requires
   an explicit causal transition if the audience would otherwise perceive a teleport.

7. VEHICLES ARE PHYSICAL.
   When a character drives: entering vehicle → door closes / engine starts → vehicle departs → road motion
   / route context → arrival / stopping. When riding with another character, keep the interior geography,
   seating positions and speaker identities stable while the vehicle moves.

8. CONTINUITY HANDOFF.
   The previous shot's end state becomes the next shot's opening state. If the previous shot ends with a
   hand on a car door, the next shot starts with the same hand/door relationship before new motion begins.
   This is not just a writing convention — end_frame_transition and next_shot_continuity are the exact
   contract the video provider (Agnes keyframe mode or LTX-2.3 First-Last-Frame) uses to physically
   condition the next shot's clip on this shot's terminal frame, bridging into the next shot's opening
   still over roughly 3-4 seconds before its own action takes over. Write every handoff as concretely
   as you would the shot's own action — a vague or abstract handoff produces a broken physical bridge,
   not just a rough cut. Treat the transition as equally important as the shot itself.
`;

const FFMPEG_EFFECTS_CATALOG = `
═══ VIDEO EFFECTS (handled by ${_VIDEO_BACKEND_NAME} — NOT FFmpeg) ═══

All visual effects — motion, color grading, overlays, atmospheric styling — are
applied during video generation by ${_VIDEO_BACKEND_NAME}'s AI model. The FFmpeg
service is used ONLY for basic concatenation of clips and simple fade transitions
between scenes during final merge.

DO NOT specify any of the following in your script:
  - "clip_motion_effect", "clip_color_grade", "clip_overlays" (removed — ${_VIDEO_BACKEND_NAME} handles these)
  - "ffmpeg_effects" block (removed — no longer needed)
  - "composition" layout (removed — all scenes use basic "cut" concatenation)

The visual style of each shot is conveyed through the "image_prompt" field as a FROZEN STILL FRAME only.
The still-image model receives this field before video generation. Focus on frozen composition, subject identity,
pose, eyeline, spatial relationships, framing, lighting, palette, environment and atmosphere.
Camera movement, subject motion, dialogue, temporal progression, travel beats, animation, audio and end-state
changes belong only to the downstream video prompt fields and MUST NOT be placed in image_prompt.`;

// ─────────────────────────────────────────────────────────────────────────────
// Scene Continuity Bible — 180-degree axis-of-action, match-on-action, and
// prop/wardrobe permanence ACROSS THE WHOLE SCENE (not just adjacent shots).
//
// This is what separates coverage that reads as professionally-cut film
// grammar from shot-to-shot AI drift: a real editor holds a locked screen
// direction and object state across an ENTIRE scene, including cutaways and
// return shots several cuts later, not just between one shot and the next.
// The shot-to-shot continuity fields (end_frame_transition/next_shot_continuity)
// only bind adjacent pairs; this bible is the scene-wide ledger that catches
// what pairwise handoff alone misses — e.g. a prop last mentioned in shot 2
// that must still be in the same place in shot 6, even though shots 3-5 never
// referenced it.
// ─────────────────────────────────────────────────────────────────────────────

const CONTINUITY_BIBLE_RULES = `
═══ SCENE CONTINUITY BIBLE (mandatory — this is what makes coverage read as professionally cut, not AI-drifted) ═══

Before writing shot 1 of this scene, decide the scene's continuity bible — the facts every
shot in this scene must stay consistent with unless a specific later shot explicitly and
visibly authors a change. Return it once, at the top level of your response, in
"scene_continuity_bible" (a sibling of "shots", not nested inside any shot).

1. AXIS OF ACTION (180-DEGREE RULE).
   For any scene where two or more characters interact (conversation, confrontation, shared
   physical action), establish ONE imaginary line through the interacting characters the
   moment they first share a shot. Every subsequent shot of that same interaction — including
   a return to a wide/establishing shot several cuts later — MUST keep each character on the
   SAME screen side and eyeline direction established at that first shared shot, even across
   intervening close-ups or cutaways that don't show both characters. Flipping a character's
   screen side/eyeline without an authored, VISIBLE crossing (camera physically shown moving
   around the subject, or a character shown walking across frame to the other side) reads as
   a geography error, not a stylistic cut. If you deliberately cross the line, name the exact
   shot_index in "line_cross_shots" and state the visible motivation in "line_cross_reason" —
   an uncredited flip is always a mistake, a credited one is a choice.

2. PROP & WARDROBE PERMANENCE (SCENE-WIDE, NOT JUST ADJACENT).
   Track every prop that a character is holding, wearing, or positioned near as
   "active_props" and every character's established wardrobe/prop-on-person state as
   "wardrobe_lock". Once established, these persist UNCHANGED through every following shot
   of the scene — including shots that don't mention that prop/character — until a shot
   explicitly authors a change (a character setting an object down, removing a jacket, etc).
   Do not silently let a held coffee cup, a jacket, an open laptop, or a drawn weapon vanish
   or relocate between shots just because a few intervening shots didn't describe it.

3. MATCH ON ACTION.
   When a shot's terminal state is captured mid-motion (a hand reaching, a door swinging, a
   person sitting down, a turn in progress) rather than a settled pose, "motion_phase_at_cut"
   must state the exact kinetic phase — how far into the motion, and in what direction — not
   just the static end pose. ("Hand roughly 80% extended toward the doorknob, fingers not yet
   in contact" — not "reaching for the door.") The next shot's opening motion continues THAT
   exact phase rather than restarting the gesture from rest. Leave motion_phase_at_cut empty
   only when the shot genuinely ends on a settled, motionless state.

4. LIGHTING & TIME-OF-DAY LOCK.
   "lighting_lock" states the scene's established light source, direction, color temperature,
   and time-of-day evidence. It holds constant across every shot of the scene unless the story
   explicitly moves time forward within the scene (state that explicitly if so).

Every shot's character_staging, active_props references, wardrobe, and lighting must remain
consistent with the bible you declare. If a shot changes any locked fact, that shot's own
end_frame_state/end_frame_transition must say so explicitly so the bible updates for shots
that follow it within this same scene.
`;

// ─────────────────────────────────────────────────────────────────────────────
// Multi-Scene Narrative Continuity Schema
// Enforces character memory, location stability, and temporal coherence
// across all scenes in an episode. Injected into every episode script prompt.
// ─────────────────────────────────────────────────────────────────────────────

const NARRATIVE_CONTINUITY_SCHEMA = `
═══ MULTI-SCENE NARRATIVE CONTINUITY SCHEMA (mandatory — violations break the story) ═══

You are writing a SEQUENTIAL, COHERENT story. Scenes are NOT independent units — each one
is a direct continuation of the last. Apply this schema before writing any scene:

You will receive a "narrative_context_history" array containing the previous scenes' shot
configurations, locations, emotional states, and image prompts. You MUST read this history
before writing the next scene. Consecutive visual scenes must maintain ABSOLUTE contextual
progression — no overlapping concepts, no mixed environmental concepts, no teleporting
characters. Each scene builds on what the last established.

SCENE HANDOFF RULES (apply between every scene):

  1. LOCATION CONTINUITY — if Scene 2 starts in a different location from Scene 1, you must
     show or imply the transition. Characters do not teleport. Time must pass or movement must occur.
  2. CHARACTER MEMORY — every character remembers everything that happened in all prior scenes
     of THIS episode. They cannot "forget" a revelation, conflict, or emotional moment just
     because the scene changed. Reference what was said or done earlier through body language,
     dialogue subtext, or physical reaction.
  3. EMOTIONAL STATE CARRY-FORWARD — a character's emotional state at the end of Scene N is
     their STARTING emotional state in Scene N+1 (unless time has passed, in which case explain
     why they have shifted). Never reset a character to neutral between scenes.
  4. OBJECT AND PROP CONTINUITY — if a character is holding something, wearing something, or
     has been physically injured, that persists. A glass of wine doesn't vanish between shots.
     A bloody lip stays bloody until tended to.
  5. TIME COHERENCE — establish whether consecutive scenes are simultaneous (parallel action),
     immediately sequential, or have a time gap. If a time gap exists, signal it: "LATER",
     "THAT NIGHT", "THREE HOURS LATER" in the scene_description.
  6. NO CONCEPT OVERLAP — do not repeat the same visual concept, framing, or environmental
     setup in consecutive scenes. Each scene must introduce a NEW visual idea or evolve the
     previous one. If Scene 1 was a tight close-up in a lab, Scene 2 must change angle,
     distance, or location — never repeat the same composition.

${TRAVEL_CONTINUITY_RULES}

${IS_AGNES_PROVIDER ? AGNES_CONVERSATIONAL_RULES : ''}

DIALOGUE MANDATE (absolute — zero exceptions):
  Every character-led scene must contain at least one meaningful audible speech beat. Characters should
  receive spoken dialogue whenever the scene naturally supports it; when spoken dialogue would be
  unnatural, use a contextual internal voice-over from a character present in the scene. If a character
  is silent in a particular shot, describe what they visibly do — never turn that action into quoted text.

QUOTATION MARKS = SPOKEN WORDS ONLY (absolute — never violate this):
  QUOTATION MARKS may contain ONLY words that a human actor would literally say out loud.
  Examples that are VALID:
    DR. JANE: "I know what happened."
    DR. JANE: "Wait." (voice barely above a whisper, eyes fixed on the phone)
  Examples that are INVALID and MUST NEVER be produced:
    "Dr. Jane looks at her phone"
    "She looks frightened"
    "Dr. Jane turns toward the door"
    "Her hands tremble"
    "(nervous)"
    "camera slowly pushes in"
  Actions, emotions, expressions, posture, movement, subtext, tone notes, environment, and camera
  language are ALWAYS written as ordinary unquoted prose. A silent/action shot therefore contains
  no quotation marks at all. The video/audio model may voice quoted material, so quoting an action
  is functionally equivalent to telling an actor to say that action aloud.

INTERNAL MONOLOGUE: use tts_mode=internal_monologue and write NAME (V.O.): exact thought words
without quotation marks when that thought is intentionally audible. The thought must remain clearly
identified as voice-over so LTX does not confuse it with narration or visible action.


CLIFFHANGER HOOK MANDATE (final scene only):
  The LAST scene of EVERY episode must end with an intense, narrative Cliffhanger Hook.
  The hook must:
    a) Introduce an irresolvable threat, revelation, or impossible choice at maximum tension.
    b) Directly create the desire to see the next episode IMMEDIATELY.
    c) End on an unresolved note — DO NOT resolve what the hook opens.
    d) Be reflected in the final shot's "dialogue_or_action" field — the last spoken line or
       action must BE the hook, not narrate it.
`;

/**
 * Dynamic Contextual Pacing Rules — provider-aware source-of-truth contract.
 * Shot durations are calculated from spoken text length, narrative complexity,
 * semantic/environmental context, and temporal progression.
 */
const _SCRIPT_MAX_DURATION = config.videoProvider === 'agnes' ? 18.0 : Number(config.ltxMaxDuration || 10.0);
const _SCRIPT_TARGET_DURATION = config.videoProvider === 'agnes' ? 18.0 : Math.min(9.25, _SCRIPT_MAX_DURATION);
const PACING_RULES = `
═══ SEMANTIC ${_SCRIPT_MAX_DURATION}-SECOND CINEMATIC SHOT RULES (mandatory) ═══

You are directing for the selected video provider with a HARD MAXIMUM OF ${_SCRIPT_MAX_DURATION} SECONDS PER SHOT in the active StreamVerse production contract. Render time is the limiting resource, not per-shot credits, so do not waste the available temporal canvas on underdeveloped fragments. A shot should normally occupy the available cinematic canvas unless the dramatic beat is genuinely complete sooner.

Every shot is a COMPLETE MICRO-SCENE, not a split idea. Design a visible temporal arc inside the shot: setup/state → development/change → meaningful visual outcome. The environment is an active storytelling element, not wallpaper. Weather, light, objects, distant activity, room details, spatial relationships, time-of-day cues, or environmental changes should reinforce the episode's current narrative meaning.

DURATION INPUTS (the pipeline computes the final duration):
  1. Set shot_pacing_type based on what the shot IS, but do not design around 2–5 second clips.
  2. Set narrative_complexity accurately.
  3. Set environmental_story_beat to describe what the surrounding world contributes to this shot. It must be specific to the scene/episode context, not generic filler.
  4. Set temporal_arc to describe how the moment changes from beginning to end.
  5. Spoken duration is only ONE input. The pipeline also considers semantic density, environmental storytelling, temporal progression, complexity, camera language, and visual breathing room.
  6. The resulting clip duration may use the full active provider canvas when the dramatic beat benefits from sustained action, performance, environmental progression and dialogue.

SEMANTIC DENSITY RULES:
  - Never create a shot whose only meaningful content is a character saying one sentence. Let the environment reveal, react, constrain, foreshadow, or contextualize the dialogue.
  - Use the beginning of the shot to establish the visible state, the middle to develop the emotional/physical event, and the ending to land on a readable story image.
  - A silent environmental beat can be as important as a character beat: a phone vibrating on a table, a storm approaching the windows, a hallway light failing, distant emergency lights washing across the room, a kettle reaching a boil, or a door left open into an unexpected space — always tied to this episode's actual context.
  - Do not pad. Every second must contain meaningful visual information or meaningful anticipation. The active provider canvas is ${_SCRIPT_MAX_DURATION}s when Agnes is selected.

END-FRAME CONTINUITY RULES:
  - Every shot MUST end on a deliberate visual state that creates a meaningful handoff into the next shot.
  - Use one of these contextual handoff ideas when appropriate: match-on-action, eyeline continuation, object/prop match, environmental movement, sound-led bridge, spatial reveal, lighting change, time shift, or a purposeful hard cut.
  - Describe the handoff as something visible or audible in the story world, never as an instruction to an editor.
  - The next shot must clearly inherit at least one fact from the previous shot's end state: gaze direction, body position, prop position, environmental change, sound source, lighting state, spatial discovery, or unresolved action.
  - Avoid generic "cut to next shot" language. The handoff description should explain WHY the next image feels causally connected.

SHOT COUNT:
  Let semantic completeness decide shot count. Prefer fewer, richer shots that use the active provider canvas when the story benefits from it.

OPENING:
  The first scene should still establish a compelling hook, and it should be a rich cinematic visual event rather than a thin montage fragment.

INTER-SCENE HOOK:
  End each scene with a meaningful unresolved visual or narrative turn that can live inside the full temporal canvas: revelation, decision, threat, silence, reversal, arrival, discovery, or environmental change.

FORBIDDEN:
  - Do not use an artificial 4-5 second fallback. Use the active provider canvas defined above; Agnes may use up to 18 seconds, while LTX remains capped at 10 seconds.
  - Do not make every shot a close-up of a speaking character. Use environment, objects, architecture, background action, and spatial geography.
  - Do not repeat the same environmental detail across consecutive shots unless continuity requires it.
`;

const DIRECTOR_PERSONA = `You are the lead director and showrunner for StreamVerse Studios.

Your directorial identity is a synthesis of:
- Barry Jenkins' emotional intimacy and painterly frames (Moonlight, If Beale Street Could Talk)
- Park Chan-wook's formal precision and thematic obsession (Oldboy, The Handmaiden)  
- Shonda Rhimes' addictive plot architecture and character voice (Grey's Anatomy, Scandal)
- Wong Kar-wai's non-linear atmosphere and time as an emotional texture (In the Mood for Love)
- Ryan Coogler's cultural specificity and kinetic energy (Black Panther, Fruitvale Station)

Your rules as a director:
1. THEME first. Every shot, line, and lighting choice must serve the episode's central theme.
2. The camera is a character. Where it looks, how it moves, and what it refuses to show are directorial choices.
3. Emotion over event. What a character FEELS in a moment matters more than what they DO.
4. Subtext is the script. The best dialogue says one thing and means another.
5. Colour is language. Every palette decision is a statement about internal states.
6. Silence and stillness are as powerful as action and noise.
7. The audience should feel something uncomfortable, true, and specific — not safe or generic.
8. DIALOGUE IS A PRIMARY DRAMATIC ENGINE. These movies should be highly engaging and
   dialogue-forward: characters should speak frequently when the scene naturally supports it.
   Prefer meaningful exchanges, objections, revelations, questions, interruptions, confessions,
   decisions, and subtext over long stretches of people silently staring. Do not force dialogue
   into shots that are genuinely visual or atmospheric, but do not underwrite dialogue merely
   to keep scenes short. The audience should learn, feel, or anticipate something through what
   characters say. Every scene should contain substantive spoken dialogue whenever its context
   supports a speaking character, while still giving the environment and physical action room
   to carry story.
9. MULTI-CHARACTER DIALOGUE IS A CORE CINEMATIC TOOL. When two or more characters are together and the
   scene naturally supports an exchange, keep them in the same composition and let the conversation unfold
   in chronological turns with visible listener reactions. Do not split a natural exchange merely to force
   one speaker per shot. The still image remains one frozen instant; spoken words belong only to
   dialogue_or_action and the downstream video prompt.

10. SEMANTIC TRAVEL IS A CORE CINEMATIC TOOL. When a character changes location, think in terms of physical
    departure, transit and arrival. Never use a new location as a substitute for showing the movement needed
    to reach it.

You always respond with valid JSON only.`;

// ─────────────────────────────────────────────────────────────────────────────
// MULTI-SPEAKER LTX DIALOGUE — hard continuity/staging rules injected into every script prompt
// ─────────────────────────────────────────────────────────────────────────────
const MULTI_SPEAKER_LTX_RULES = `
═══ MULTI-SPEAKER CINEMATIC DIALOGUE ═══

${IS_AGNES_PROVIDER ? AGNES_CONVERSATIONAL_RULES : ''}

1. SPEAKER ORDER
   - Keep every spoken line in chronological order.
   - Each spoken line identifies the exact character who says it.
   - Actual audible words use quotation marks; staging, emotion and actions remain unquoted.

2. SHARED PERFORMANCE
   - When the story has multiple characters in the same physical place, prefer a shared composition when
     the exchange is naturally observable together. Do not force a shot/reverse-shot pattern for every line.
   - Listening characters must remain visible when their reaction materially affects the exchange.
   - A character may speak, move, stop, turn, approach, sit, stand or interact with an object during the same shot.

3. VISUAL STAGING — MASTER SPATIAL CONTRACT
   - characters_in_shot must include every visible speaking and listening character.
   - character_staging must contain exactly one row for every visible character. Each row must specify:
     screen_position, depth, facing/facing_toward, a STATIC physical state or contact/prop relationship,
     pose, eyeline/gaze, interaction, speaking, and a short visual_identity disambiguator.
   - The staging "action" field is a FROZEN PHYSICAL STATE, never a movement instruction. Prefer
     "right hand resting on the table" or "standing with both feet planted" over "reaches for the table"
     or "walks toward the table."
   - Build the frozen opening image from character_staging. The image_prompt must visibly realize the exact
     same screen position, depth, pose, eyeline, facing direction and static interaction for every character.
   - The downstream video prompt must reuse this same spatial map. Do not invent a second spatial layout.

4. CONTINUITY
   - start_frame_state is the exact opening visual state of the shot.
   - end_frame_state is the exact terminal visual state at the shot's final frame.
   - A continuation shot must begin from the previous shot's terminal pose, screen geography, hands/props,
     gaze, expression, lighting and framing before any new movement begins.
   - When the context genuinely changes, establish the new geography and causal transition; characters do not teleport.

5. STILL / VIDEO BOUNDARY
   - image_prompt = one exact frozen visual opening frame and NOTHING ELSE.
   - image_prompt must contain zero movement instructions, temporal language, dialogue, audio, camera movement,
     travel instructions, end-state progression, or animation language.
   - dialogue_or_action, subject_motion, camera_movement, temporal_arc, travel stages, route beats, end-frame
     progression and ambience belong exclusively downstream to the video-generation branch.
   - Only spoken words are quoted. All descriptive staging remains unquoted.

6. TRAVEL INTEGRITY
   - If a shot belongs to a location transition, explicitly preserve its travel_stage and make the opening frame
     the character's real state at that moment of the journey — not a destination pose borrowed from a later shot.
`;
// ─────────────────────────────────────────────────────────────────────────────
// LLM transport helpers
// ─────────────────────────────────────────────────────────────────────────────

async function _agnesAiPost(systemPrompt, userPrompt, maxTokens, key, temperature = 0.92) {
  const resp = await axios.post(
    'https://apihub.agnes-ai.com/v1/chat/completions',
    {
      model:           config.agnesAiTextModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      temperature,
      response_format: { type: 'json_object' },
    },
    {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: 600000,
    }
  );
  const choice = resp.data?.choices?.[0];
  return { content: choice?.message?.content, finishReason: choice?.finish_reason };
}

async function _agnesAiStream(systemPrompt, userPrompt, maxTokens, key, temperature = 0.92) {
  const resp = await axios.post(
    'https://apihub.agnes-ai.com/v1/chat/completions',
    {
      model:           config.agnesAiTextModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      temperature,
      response_format: { type: 'json_object' },
      stream:          true,
    },
    {
      headers:      { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout:      600000,
      responseType: 'stream',
    }
  );

  return new Promise((resolve, reject) => {
    let fullContent  = '';
    let finishReason = null;
    let buf          = '';

    resp.data.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        const t = line.trim();
        if (!t || !t.startsWith('data: ')) continue;
        const payload = t.slice(6).trim();
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          const delta  = parsed.choices?.[0]?.delta?.content;
          if (delta) fullContent += delta;
          const fr = parsed.choices?.[0]?.finish_reason;
          if (fr) finishReason = fr;
        } catch (_) { /* partial chunk — skip */ }
      }
    });

    resp.data.on('end', () =>
      resolve({ content: fullContent, finishReason: finishReason || 'stop' }));
    resp.data.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM call — Agnes AI primary / Groq fallback, both with key rotation
// ─────────────────────────────────────────────────────────────────────────────

function _retryDelayMs(err, fallbackMs = 1200) {
  const retryAfter = err?.response?.headers?.['retry-after'];
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 250), 30000);

  const status = err?.response?.status;
  if (status === 429) return 2500;
  if (status >= 500) return fallbackMs;
  if (['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH'].includes(err?.code)) {
    return fallbackMs;
  }
  return 0;
}

async function _sleepForRetry(err, fallbackMs = 1200) {
  const delay = _retryDelayMs(err, fallbackMs);
  if (delay > 0) {
    console.warn(`[LLM] transient provider failure; waiting ${delay}ms before retry/rotation`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

async function callLLM(systemPrompt, userPrompt, maxTokens = undefined, opts = {}) {
  // maxTokens is intentionally not forwarded to providers: application-level output caps are disabled.
  const { useStream = false, temperature = 0.92 } = opts;
  const requestChars = (systemPrompt?.length || 0) + (userPrompt?.length || 0);
  const approxInputTokens = Math.ceil(requestChars / 4);
  const timeoutMs = 600000;
  if (requestChars > 40000) {
    console.warn(`[LLM] LARGE REQUEST WARNING | inputChars=${requestChars} approxInputTokens=${approxInputTokens} maxOutputTokens=provider-default temperature=${temperature}`);
  }
  console.log(`[LLM] Structured completion: provider/model limits apply | inputChars=${requestChars} approxInputTokens=${approxInputTokens} maxOutputTokens=provider-default temperature=${temperature} timeoutMs=${timeoutMs}`);

  const transientCodes = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH']);
  const retrySameKey = async (err, provider, key, attempt, maxAttempts = 2) => {
    if (attempt >= maxAttempts) return false;
    const status = err?.response?.status;
    const code = err?.code;
    const delay = _retryDelayMs(err, attempt === 1 ? 1000 : 2000);
    console.warn(`[LLM] ${provider} failure on current key (${code || `HTTP ${status || 'unknown'}`}); ` +
      `retry ${attempt + 1}/${maxAttempts} after ${delay}ms`);
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    return true;
  };

  // PRIMARY: exhaust every Agnes AI key before handing the exact same
  // request to Groq. No Agnes AI error is allowed to escape this loop
  // prematurely. (This used to be Mistral — swapped after Mistral suspended
  // its free tier without notice. Same rotation mechanism, same fallback
  // position, only the pool/endpoint/model changed. NOTE: "Agnes AI" here
  // is apihub.agnes-ai.com's text model — unrelated to the separate VIDEO
  // generation "Agnes" provider used elsewhere in this codebase; see the
  // naming warning on config.agnesAiKeys in configCore.js.)
  for (let i = 0; i < config.agnesAiKeys.length; i++) {
    const key = config.getNextAgnesAiKey();
    if (!key) continue;

    for (let attempt = 1; attempt <= 2; attempt++) {
      let requestStartedAt;
      try {
        requestStartedAt = Date.now();
        console.log(`[LLM] Agnes AI request started | keyIndex=${i + 1}/${config.agnesAiKeys.length} attempt=${attempt}/2 stream=${useStream} inputChars=${requestChars} approxInputTokens=${approxInputTokens}`);
        const { content, finishReason } = useStream
          ? await _agnesAiStream(systemPrompt, userPrompt, maxTokens, key, temperature)
          : await _agnesAiPost(systemPrompt, userPrompt, maxTokens, key, temperature);

        if (!content) throw new Error('Empty Agnes AI response');
        if (finishReason === 'length') {
          const e = new Error('[LLM] Agnes AI provider truncated the response at its model limit');
          e.llmTruncated = true;
          throw e;
        }

        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch (jsonErr) {
          throw new Error('[LLM] Agnes AI non-JSON: ' + jsonErr.message);
        }

        console.log(`[LLM] Agnes AI request succeeded | durationMs=${Date.now() - requestStartedAt} finishReason=${finishReason || 'n/a'} outputChars=${content.length}`);
        config.markKeyStatus('agnesAi', key, 'active');
        return parsed;
      } catch (err) {
        const durationMs = typeof requestStartedAt === 'number' ? Date.now() - requestStartedAt : undefined;
        const status = err?.response?.status;
        const code = err?.code;
        const detail = err?.response?.data?.message ||
          err?.response?.data?.error?.message ||
          err?.message ||
          'unknown Agnes AI error';
        console.warn(`[LLM] Agnes AI request failed | durationMs=${durationMs ?? 'n/a'} inputChars=${requestChars} approxInputTokens=${approxInputTokens} status=${status || 'n/a'} code=${code || 'n/a'} detail=${detail}`);

        // Agnes AI's documented status codes: 401 = auth, 402 = insufficient
        // balance/Token-Plan quota, 403 = access forbidden, 429 = RPM limit
        // exceeded. All four are key/request failures for this attempt —
        // rotate, never let the request terminate before every configured
        // Agnes AI key has had its chance.
        if (status === 401 || status === 402 || status === 403 || status === 429) {
          config.markKeyStatus('agnesAi', key, status === 429 ? 'rate-limited' : 'exhausted');
          console.warn(`[LLM] Agnes AI key failed (${status}), rotating...`);
          await _sleepForRetry(err, 1500);
          break;
        }

        if (await retrySameKey(err, 'Agnes AI', key, attempt)) continue;

        config.markKeyStatus('agnesAi', key, 'exhausted');
        console.warn(`[LLM] Agnes AI key exhausted after ${attempt}/2 attempts; rotating. ` +
          `status=${status || 'n/a'} code=${code || 'n/a'} reason=${detail}`);
        await _sleepForRetry(err, 1500);
        break;
      }
    }
  }

  console.warn(`[LLM] All Agnes AI keys exhausted; falling back to Groq`);

  // FALLBACK: once Agnes AI is exhausted, Groq is always attempted with the
  // exact same structured request, including after unusual/unknown Agnes AI
  // errors such as 404, 400, invalid JSON, truncation, or endpoint failures.
  for (let i = 0; i < config.groqKeys.length; i++) {
    const key = config.getNextGroqKey();
    if (!key) continue;

    for (let attempt = 1; attempt <= 2; attempt++) {
      let requestStartedAt;
      try {
        requestStartedAt = Date.now();
        console.log(`[LLM] Groq request started | keyIndex=${i + 1}/${config.groqKeys.length} attempt=${attempt}/2 inputChars=${requestChars} approxInputTokens=${approxInputTokens}`);
        const resp = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
          model: config.groqModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature,
              response_format: { type: 'json_object' },
        }, {
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          timeout: 600000,
        });

        const choice = resp.data?.choices?.[0];
        const content = choice?.message?.content;
        if (!content) throw new Error('Empty Groq response');
        if (choice.finish_reason === 'length') {
          const e = new Error('[LLM] Groq provider truncated the response at its model limit');
          e.llmTruncated = true;
          throw e;
        }

        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch (jsonErr) {
          throw new Error('[LLM] Groq non-JSON: ' + jsonErr.message);
        }

        console.log(`[LLM] Groq request succeeded | durationMs=${Date.now() - requestStartedAt} finishReason=${choice.finish_reason || 'n/a'} outputChars=${content.length}`);
        config.markKeyStatus('groq', key, 'active');
        return parsed;
      } catch (err) {
        const durationMs = typeof requestStartedAt === 'number' ? Date.now() - requestStartedAt : undefined;
        const status = err?.response?.status;
        const code = err?.code;
        const detail = err?.response?.data?.error?.message ||
          err?.response?.data?.message ||
          err?.message ||
          'unknown Groq error';
        console.warn(`[LLM] Groq request failed | durationMs=${durationMs ?? 'n/a'} inputChars=${requestChars} approxInputTokens=${approxInputTokens} status=${status || 'n/a'} code=${code || 'n/a'} detail=${detail}`);

        if (status === 401 || status === 402 || status === 403 || status === 429) {
          config.markKeyStatus('groq', key, status === 429 ? 'rate-limited' : 'exhausted');
          console.warn(`[LLM] Groq key failed (${status}), rotating...`);
          await _sleepForRetry(err, 1500);
          break;
        }

        if (await retrySameKey(err, 'Groq', key, attempt)) continue;

        config.markKeyStatus('groq', key, 'exhausted');
        console.warn(`[LLM] Groq key exhausted after ${attempt}/2 attempts; rotating. ` +
          `status=${status || 'n/a'} code=${code || 'n/a'} reason=${detail}`);
        await _sleepForRetry(err, 1500);
        break;
      }
    }
  }

  const e = new Error('[LLM] All Agnes AI and Groq keys exhausted');
  e.llmExhausted = true;
  throw e;
}

// ─────────────────────────────────────────────────────────────────────────────
// CAST-FIRST ARCHITECTURE
//
// Step 1: writeSeriesSummary() — simulate the full movie internally
// Step 2: writeCastBible() — generate every character with metadata + seed + voice
// Step 3: writeEpisodeScript() — uses locked cast + series summary as global context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Accept season endpoints in any order only when their season numbers form a
 * complete, unique 1..N set, then canonicalize them into season order.
 * Missing, duplicated, or out-of-range season numbers remain hard validation
 * errors; their narrative content cannot be safely inferred or reassigned.
 */
function _normalizeSeasonEndpoints(endpoints, seasonsPerSeries, label = 'Series simulation') {
  if (!Array.isArray(endpoints) || endpoints.length !== seasonsPerSeries) {
    throw new Error(`[ScriptWriter] ${label} invalid: expected ${seasonsPerSeries} season endpoints`);
  }

  const bySeason = new Map();
  for (const endpoint of endpoints) {
    const season = Number(endpoint?.season);
    if (!Number.isInteger(season) || season < 1 || season > seasonsPerSeries || bySeason.has(season)) {
      const found = endpoints.map(item => item?.season).join(', ');
      throw new Error(
        `[ScriptWriter] ${label} invalid: season endpoints must contain each season 1-${seasonsPerSeries} exactly once; found [${found}]`
      );
    }
    bySeason.set(season, endpoint);
  }

  if (bySeason.size !== seasonsPerSeries) {
    throw new Error(
      `[ScriptWriter] ${label} invalid: season endpoints must contain each season 1-${seasonsPerSeries} exactly once`
    );
  }

  const ordered = Array.from({ length: seasonsPerSeries }, (_, index) => bySeason.get(index + 1));
  if (ordered.some((endpoint, index) => endpoint !== endpoints[index])) {
    console.warn(`[ScriptWriter] Reordered season endpoints into canonical season order (1-${seasonsPerSeries})`);
  }
  return ordered;
}

/**
 * Step 1: Comprehensive Series Summary
 *
 * The master plan is generated once, but episode trajectories are generated in
 * bounded, resumable chunks so a large series can never depend on one giant
 * structured completion. The merged result remains one canonical
 * full_story_simulation for every downstream stage.
 */
async function writeSeriesSummary(
  genre,
  {
    episodesPerSeason = 8,
    seasonsPerSeries = 4,
    initialSimulation = null,
    onCheckpoint = null,
    generateEpisodeTrajectories = false,
  } = {}
) {
  const systemPrompt = `${DIRECTOR_PERSONA}

You are the showrunner planning a complete ${genre} series for StreamVerse Studios.
Before a single episode is written, you must understand the ENTIRE series —
every character, every arc, the beginning and the ending. This is the master
document that governs all episode generation.

Do NOT generate episode-by-episode trajectories in this completion. They will be
generated separately in validated continuity chunks after the master plan is locked.`;

  const userPrompt = `Create a comprehensive ${genre} series master plan.

You must know exactly how the series begins and how it ends. Simulate the full
story internally — every character's role, what they will be doing across the
entire series, and how every thread resolves.

Return JSON with these exact fields:
{
  "title": "Series title — distinctive, thematic, not generic",
  "genre": "${genre}",
  "logline": "One precise, emotionally devastating sentence capturing what the show is REALLY about",
  "central_theme": "The philosophical or psychological question at the core of the entire series",
  "tone_manifesto": "2-3 sentences describing the emotional register: how does this show feel?",
  "visual_language": {
    "primary_palette": "The dominant colour temperature and specific hues",
    "recurring_motifs": ["3-5 visual symbols that repeat across episodes"],
    "camera_philosophy": "How the camera moves and what that movement means emotionally"
  },
  "comprehensive_summary": "5-8 paragraph master summary of the ENTIRE series. Each paragraph covers one season. Be specific about what CHANGES in each character's inner life. This is the global context every episode writer will read before writing any episode. It must contain: the opening state of the world, how each season escalates, the central conflicts, the climax, and the resolution. Name every character and their role in the arc.",
  "season_arcs": [
${Array.from({ length: seasonsPerSeries }, (_, i) => `    "Season ${i + 1} arc"`).join(',\n')}
  ],
  "full_story_simulation": {
    "opening_state": "",
    "inciting_event": "",
    "season_endpoints": ${JSON.stringify(
      Array.from({ length: seasonsPerSeries }, (_, i) => ({
        season: i + 1,
        beginning: '',
        turning_points: ['', '', ''],
        ending: '',
      })),
      null,
      2
    )},
    "episode_trajectory": [],
    "finale_resolution": "",
    "unresolved_threads": []
  },
  "character_bible": [
    {
      "name": "Character name",
      "role": "protagonist|antagonist|supporting",
      "gender": "male|female",
      "description": "Their psychology, wound, desire, fear, and the contradiction they live in",
      "arc": "Where they begin emotionally vs where they end 4 seasons later",
      "performance_note": "One sentence a director would whisper to the actor",
      "visual_profile": {
        "gender": "male|female",
        "hair": "Exact shade, texture, length, style",
        "eyes": "Exact colour, shape, intensity",
        "skin": "Exact tone, undertone, texture",
        "build": "Height, frame, posture",
        "signature_clothing": "Their default aesthetic and one signature piece",
        "distinguishing_features": "Specific marks, mannerisms, or physical tells"
      }
    }
  ],
  "engagement_hook": "The single existential question the audience will argue about",
  "premiere_announcement": "The Discord/social post copy announcing this series premiere — maximum hype. 2-3 sentences + 6-8 hashtags."
}

Generate 4-6 main characters. Generate EVERY character the series needs — protagonist,
antagonist, and supporting cast. Each character must have a clear role in the full series arc.

There are ${seasonsPerSeries} seasons with ${episodesPerSeason} episodes each.
Populate exactly ${seasonsPerSeries} season_endpoints, in ascending order, with
season values exactly 1 through ${seasonsPerSeries}, each used once. Leave
episode_trajectory as an empty array; it is filled in continuity-preserving
chunks immediately after this master response is validated.

Make every field specific and surprising — no generic TV tropes.`;

  let result;
  let sim;
  const stored = initialSimulation && typeof initialSimulation === 'object' ? initialSimulation : null;

  if (stored?.season_endpoints?.length === seasonsPerSeries && stored?.opening_state) {
    sim = stored;
    result = {
      title: stored.title || 'StreamVerse Series',
      genre: stored.genre || genre,
      logline: stored.logline || '',
      central_theme: stored.central_theme || '',
      tone_manifesto: stored.tone_manifesto || '',
      visual_language: stored.visual_language || {},
      comprehensive_summary: stored.comprehensive_summary || '',
      plot_summary: stored.plot_summary || stored.comprehensive_summary || '',
      season_arcs: stored.season_arcs || [],
      character_bible: stored.character_bible || [],
      engagement_hook: stored.engagement_hook || '',
      premiere_announcement: stored.premiere_announcement || '',
    };
    console.log('[ScriptWriter] ↺ Resuming persisted master series simulation from DB checkpoint');
  } else {
    result = await callLLM(systemPrompt, userPrompt, 7000);
    sim = result?.full_story_simulation;
  }

  const expectedEpisodes = seasonsPerSeries * episodesPerSeason;
  if (!sim) {
    throw new Error('[ScriptWriter] Full series simulation invalid: master simulation object missing');
  }
  sim = {
    ...sim,
    season_endpoints: _normalizeSeasonEndpoints(
      sim.season_endpoints,
      seasonsPerSeries,
      'Full series simulation'
    ),
  };

  // New production architecture: the master series plan is durable, but
  // episode trajectories are generated on demand in a rolling 3–5 episode
  // horizon immediately before production of the current episode. The legacy
  // full-series chunk generator remains available through generateEpisodeTrajectories
  // for backwards compatibility, but is OFF by default.
  const storedTrajectories = Array.isArray(sim.episode_trajectory) ? sim.episode_trajectory : [];
  if (generateEpisodeTrajectories) {
    const expectedEpisodes = episodesPerSeason * seasonsPerSeries;
    const initialTrajectories = storedTrajectories.filter(ep => ep && ep.season && ep.episode);
    const masterCheckpoint = {
      ...result,
      full_story_simulation: {
        ...sim,
        episode_trajectory: initialTrajectories,
        simulation_status: initialTrajectories.length >= expectedEpisodes ? 'complete' : 'in_progress',
        simulation_total_episodes: expectedEpisodes,
        simulation_completed_episodes: initialTrajectories.length,
        simulation_window_start: initialTrajectories.length ? Math.min(...initialTrajectories.map(e => Number(e.global_episode) || 0)) : null,
        simulation_window_end: initialTrajectories.length ? Math.max(...initialTrajectories.map(e => Number(e.global_episode) || 0)) : null,
      },
    };
    if (onCheckpoint) {
      await onCheckpoint({
        stage: 'master',
        seriesData: masterCheckpoint,
        fullStorySimulation: masterCheckpoint.full_story_simulation,
        completedTrajectories: initialTrajectories,
      });
    }
    const episodeTrajectory = await buildSeriesEpisodeTrajectories({
      masterSimulation: masterCheckpoint.full_story_simulation,
      storyline: {
        ...result,
        title: result.title,
        genre: result.genre,
        logline: result.logline,
        central_theme: result.central_theme,
        comprehensive_summary: result.comprehensive_summary,
        plot_summary: result.plot_summary || result.comprehensive_summary,
        season_arcs: result.season_arcs,
      },
      characters: result.character_bible || [],
      episodesPerSeason,
      seasonsPerSeries,
      initialTrajectories,
      onChunkLocked: onCheckpoint ? async ({ trajectories, completedChunks, totalChunks: chunks }) => {
        const fullStorySimulation = {
          ...sim,
          episode_trajectory: trajectories,
          simulation_status: 'in_progress',
          simulation_total_episodes: expectedEpisodes,
          simulation_completed_episodes: trajectories.length,
          simulation_completed_chunks: completedChunks,
          simulation_total_chunks: chunks,
        };
        await onCheckpoint({
          stage: 'chunk',
          seriesData: { ...masterCheckpoint, full_story_simulation: fullStorySimulation },
          fullStorySimulation,
          completedTrajectories: trajectories,
          completedChunks,
          totalChunks: chunks,
        });
      } : null,
    });
    result.full_story_simulation = {
      ...sim,
      episode_trajectory: episodeTrajectory,
      simulation_status: 'complete',
      simulation_total_episodes: expectedEpisodes,
      simulation_completed_episodes: episodeTrajectory.length,
    };
  } else {
    result.full_story_simulation = {
      ...sim,
      episode_trajectory: storedTrajectories,
      simulation_status: 'master_only',
      simulation_total_episodes: episodesPerSeason * seasonsPerSeries,
      simulation_completed_episodes: storedTrajectories.length,
      simulation_completed_chunks: 0,
      simulation_total_chunks: 0,
      simulation_window_start: storedTrajectories.length ? Math.min(...storedTrajectories.map(e => Number(e.global_episode) || 0)) : null,
      simulation_window_end: storedTrajectories.length ? Math.max(...storedTrajectories.map(e => Number(e.global_episode) || 0)) : null,
    };
    if (onCheckpoint) {
      await onCheckpoint({
        stage: 'master',
        seriesData: result,
        fullStorySimulation: result.full_story_simulation,
        completedTrajectories: storedTrajectories,
      });
    }
  }

  return result;
}

/**
 * Generate the complete episode trajectory using bounded continuity chunks.
 * Every successfully locked chunk is returned through onChunkLocked so the
 * caller can durably checkpoint it before the next provider call begins.
 */
async function buildSeriesEpisodeTrajectories({
  masterSimulation,
  storyline,
  characters,
  episodesPerSeason = 8,
  seasonsPerSeries = 4,
  initialTrajectories = [],
  onChunkLocked = null,
  targetStartGlobalEpisode = null,
  targetEndGlobalEpisode = null,
}) {
  const expectedEpisodes = episodesPerSeason * seasonsPerSeries;
  const chunkSize = Math.min(5, episodesPerSeason);
  const trajectories = Array.isArray(initialTrajectories)
    ? initialTrajectories.map(ep => ({ ...ep, season: Number(ep.season), episode: Number(ep.episode), global_episode: Number(ep.global_episode) }))
    : [];
  const seen = new Set(trajectories.map(ep => `${ep.season}:${ep.episode}`));

  const orderedChunks = [];
  const totalSeriesEpisodes = episodesPerSeason * seasonsPerSeries;
  const rangeStart = Math.max(1, Number(targetStartGlobalEpisode) || 1);
  const rangeEnd = Math.min(
    totalSeriesEpisodes,
    Math.max(rangeStart, Number(targetEndGlobalEpisode) || totalSeriesEpisodes)
  );

  let globalEpisode = rangeStart;
  while (globalEpisode <= rangeEnd) {
    const chunkEndGlobal = Math.min(rangeEnd, globalEpisode + chunkSize - 1);
    const startSeason = Math.floor((globalEpisode - 1) / episodesPerSeason) + 1;
    const startEpisode = ((globalEpisode - 1) % episodesPerSeason) + 1;
    const endSeason = Math.floor((chunkEndGlobal - 1) / episodesPerSeason) + 1;
    const endEpisode = ((chunkEndGlobal - 1) % episodesPerSeason) + 1;

    // Never cross a season boundary inside one provider request.
    const safeEndGlobal = startSeason !== endSeason
      ? Math.min(chunkEndGlobal, startSeason * episodesPerSeason)
      : chunkEndGlobal;
    const safeEndEpisode = ((safeEndGlobal - 1) % episodesPerSeason) + 1;

    orderedChunks.push({
      season: startSeason,
      startEpisode,
      endEpisode: safeEndEpisode,
      expectedKeys: Array.from(
        { length: safeEndEpisode - startEpisode + 1 },
        (_, i) => `${startSeason}:${startEpisode + i}`
      ),
    });

    globalEpisode = safeEndGlobal + 1;
  }

  for (let chunkIndex = 0; chunkIndex < orderedChunks.length; chunkIndex++) {
    const chunk = orderedChunks[chunkIndex];
    if (chunk.expectedKeys.every(key => seen.has(key))) {
      console.log(`[ScriptWriter] ↺ Series trajectory chunk ${chunkIndex + 1}/${orderedChunks.length} already checkpointed: S${chunk.season}E${chunk.startEpisode}-E${chunk.endEpisode}`);
      continue;
    }

    let generated = false;
    let lastValidationError = null;
    let pendingKeys = chunk.expectedKeys.filter(key => !seen.has(key));
    const chunkByKey = new Map();
    for (const ep of trajectories.filter(ep => chunk.expectedKeys.includes(`${ep.season}:${ep.episode}`))) {
      chunkByKey.set(`${ep.season}:${ep.episode}`, ep);
    }

    const MAX_CHUNK_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS && pendingKeys.length; attempt++) {
      try {
        const requestedKeys = [...pendingKeys];
        const previous = trajectories.slice(-5);
        const requestedCoordinates = requestedKeys.map(key => {
          const [s, e] = key.split(':');
          const globalEpisode = (Number(s) - 1) * episodesPerSeason + Number(e);
          return `  S${s}E${e} (global_episode ${globalEpisode})`;
        }).join('\n');

        const systemPrompt = `${DIRECTOR_PERSONA}
You are the continuity showrunner for StreamVerse Studios.
Generate ONLY the requested missing episode trajectories for the specified coordinates.
These trajectories are authoritative and must connect to prior locked episodes and preserve
all locked series facts. If repairing an incomplete episode, preserve all already-valid
fields and complete the missing fields without changing established canon. Return JSON only.`;

        const userPrompt = `SERIES: "${storyline.title}" (${storyline.genre})
LOGLINE: ${storyline.logline || ''}
THEME: ${storyline.central_theme || ''}
SEASONS: ${seasonsPerSeries}
EPISODES PER SEASON: ${episodesPerSeason}

MASTER SERIES SUMMARY:
${storyline.comprehensive_summary || storyline.plot_summary || ''}

SEASON ARCS:
${JSON.stringify(storyline.season_arcs || [])}

LOCKED SERIES SIMULATION:
${JSON.stringify({
  opening_state: masterSimulation.opening_state || '',
  inciting_event: masterSimulation.inciting_event || '',
  season_endpoints: masterSimulation.season_endpoints || [],
  finale_resolution: masterSimulation.finale_resolution || '',
  unresolved_threads: masterSimulation.unresolved_threads || [],
})}

CAST:
${(characters || []).map(c => `${c.name}: ${c.role}; ${c.description}; arc=${c.arc || ''}`).join('\n')}

REQUESTED / REPAIR TRAJECTORIES (${requestedKeys.length}):
${requestedCoordinates}

PREVIOUS LOCKED TRAJECTORIES:
${JSON.stringify(previous)}

ALREADY LOCKED WITHIN THIS CURRENT RANGE:
${JSON.stringify([...chunkByKey.values()])}

Return exactly one trajectory object for EACH requested coordinate and no others.
For each requested episode, EVERY field below is mandatory and must be non-empty:
opening, inciting, middle_turn, climax, ending, next_hook, character_changes (non-empty array).
Do not alter coordinates. Do not omit fields. Do not return placeholder text.
${requestedKeys.length === 1 ? 'This is a targeted repair. Focus on completing this one episode completely and coherently.' : ''}

JSON shape:
{
  "episode_trajectory": [
    {
      "global_episode": 1,
      "season": 1,
      "episode": 1,
      "opening": "",
      "inciting": "",
      "middle_turn": "",
      "climax": "",
      "ending": "",
      "next_hook": "",
      "character_changes": [""]
    }
  ]
}`;

        const result = await callLLM(systemPrompt, userPrompt, 3500, { useStream: false });
        const raw = Array.isArray(result?.episode_trajectory) ? result.episode_trajectory : [];
        const requestedSet = new Set(requestedKeys);
        const seenReturned = new Set();

        if (!raw.length) throw new Error(`no trajectory objects returned for ${requestedKeys.join(', ')}`);

        for (const rawEp of raw) {
          const ep = {
            ...rawEp,
            season: Number(rawEp.season),
            episode: Number(rawEp.episode),
            global_episode: Number(rawEp.global_episode),
          };
          const key = `${ep.season}:${ep.episode}`;
          if (!requestedSet.has(key)) throw new Error(`chunk returned unexpected trajectory ${key}`);
          if (seenReturned.has(key) || seen.has(key)) throw new Error(`chunk returned duplicate trajectory ${key}`);
          const expectedGlobal = (ep.season - 1) * episodesPerSeason + ep.episode;
          if (ep.global_episode !== expectedGlobal) throw new Error(`trajectory ${key} has global_episode=${ep.global_episode}, expected ${expectedGlobal}`);

          const complete = !!ep.opening && !!ep.inciting && !!ep.middle_turn && !!ep.climax &&
            !!ep.ending && !!ep.next_hook && Array.isArray(ep.character_changes) && ep.character_changes.length > 0;
          if (complete) {
            chunkByKey.set(key, ep);
            seenReturned.add(key);
          } else {
            console.warn(`[ScriptWriter] Trajectory ${key} returned incomplete; preserving any valid siblings and repairing ${key} only.`);
          }
        }

        pendingKeys = chunk.expectedKeys.filter(key => !chunkByKey.has(key) && !seen.has(key));
        if (pendingKeys.length) {
          lastValidationError = new Error(`incomplete/missing trajectory: ${pendingKeys.join(', ')}`);
          console.warn(`[ScriptWriter] Series trajectory chunk ${chunkIndex + 1}/${orderedChunks.length} attempt ${attempt}/${MAX_CHUNK_ATTEMPTS} requires targeted repair: ${pendingKeys.join(', ')}`);
          if (attempt < MAX_CHUNK_ATTEMPTS) await _sleepForRetry(lastValidationError, Math.min(5000, 900 * attempt));
        } else {
          const chunkOutput = chunk.expectedKeys.map(key => chunkByKey.get(key)).filter(Boolean);
          for (const ep of chunkOutput) {
            const key = `${ep.season}:${ep.episode}`;
            if (!seen.has(key)) {
              seen.add(key);
              trajectories.push(ep);
            }
          }

          console.log(`[ScriptWriter] Series trajectory chunk ${chunkIndex + 1}/${orderedChunks.length} locked: S${chunk.season}E${chunk.startEpisode}-E${chunk.endEpisode} (${chunkOutput.length} episodes)`);
          if (onChunkLocked) {
            await onChunkLocked({
              trajectories: [...trajectories].sort((a, b) => Number(a.global_episode) - Number(b.global_episode)),
              completedChunks: orderedChunks.filter(c => c.expectedKeys.every(key => seen.has(key))).length,
              totalChunks: orderedChunks.length,
              chunkIndex,
              chunk,
            });
          }
          generated = true;
        }
      } catch (err) {
        lastValidationError = err;
        console.warn(`[ScriptWriter] Series trajectory chunk ${chunkIndex + 1}/${orderedChunks.length} attempt ${attempt}/${MAX_CHUNK_ATTEMPTS} failed: ${err.message}`);
        if (attempt < MAX_CHUNK_ATTEMPTS) await _sleepForRetry(err, Math.min(5000, 900 * attempt));
      }
    }

    if (!generated) {
      const error = new Error(`[ScriptWriter] Full series simulation invalid: could not lock trajectory chunk S${chunk.season}E${chunk.startEpisode}-E${chunk.endEpisode} after ${MAX_CHUNK_ATTEMPTS} attempts: ${lastValidationError?.message || 'unknown error'}`);
      error.cause = lastValidationError;
      throw error;
    }
  }

  const missingAll = [];
  for (const chunk of orderedChunks) {
    for (const key of chunk.expectedKeys) {
      if (!seen.has(key)) missingAll.push(key);
    }
  }
  if (missingAll.length) {
    throw new Error(`[ScriptWriter] Episode trajectory window invalid: missing ${missingAll.length} requested trajectories (${missingAll.join(', ')})`);
  }

  const windowOnly = targetStartGlobalEpisode != null
    ? trajectories
        .filter(ep => Number(ep.global_episode) >= rangeStart && Number(ep.global_episode) <= rangeEnd)
        .sort((a, b) => Number(a.global_episode) - Number(b.global_episode))
    : trajectories.sort((a, b) => Number(a.global_episode) - Number(b.global_episode));

  return windowOnly;
}


/**
 * Generate only the next rolling episode trajectory horizon.
 * The master series plan remains canonical; detailed episode trajectories are
 * generated immediately ahead of production and stored durably.
 */
async function simulateEpisodeTrajectoryWindow({
  storyline,
  characters,
  startGlobalEpisode,
  windowSize = 5,
}) {
  const master = storyline?.full_story_simulation
    ? (typeof storyline.full_story_simulation === 'string'
      ? safeJsonParse(storyline.full_story_simulation, {})
      : storyline.full_story_simulation)
    : {};

  const episodesPerSeason = Number(storyline?.episodes_per_season) || 20;
  const seasonsPerSeries = Number(storyline?.seasons_per_series) || 4;
  const totalEpisodes = episodesPerSeason * seasonsPerSeries;
  const start = Math.max(1, Number(startGlobalEpisode) || 1);
  const size = Math.max(3, Math.min(5, Number(windowSize) || 5));
  const end = Math.min(totalEpisodes, start + size - 1);

  const existing = Array.isArray(master.episode_trajectory)
    ? master.episode_trajectory.filter(ep =>
        Number(ep?.global_episode) >= start &&
        Number(ep?.global_episode) <= end
      )
    : [];

  const generated = await buildSeriesEpisodeTrajectories({
    masterSimulation: master,
    storyline,
    characters,
    episodesPerSeason,
    seasonsPerSeries,
    initialTrajectories: existing,
    targetStartGlobalEpisode: start,
    targetEndGlobalEpisode: end,
  });

  const byGlobal = new Map(generated.map(ep => [Number(ep.global_episode), ep]));
  const ordered = [];
  for (let globalEpisode = start; globalEpisode <= end; globalEpisode++) {
    const ep = byGlobal.get(globalEpisode);
    if (!ep) {
      throw new Error(`[ScriptWriter] Rolling trajectory window missing global episode ${globalEpisode}`);
    }
    ordered.push(ep);
  }

  console.log(`[ScriptWriter] Rolling trajectory window locked: E${start}-E${end} (${ordered.length} episodes)`);
  return ordered;
}

/**
 * Step 2: Cast Bible — Lock every character with visual metadata, seed, and voice ID.
 *
 * Takes the raw character_bible from writeSeriesSummary and enriches each character
 * with:
 *   - visual_anchor (comma-separated tag-lock for CF worker prompt injection)
 *   - seed (deterministic integer for reproducible image generation)
 *   - voice_id (Deepgram Aura voice assigned by gender + name hash)
 *
 * This is the FIRST thing that happens when starting a new series — characters are
 * generated and locked BEFORE any episode script is written.
 */
async function writeCastBible(seriesSummary) {
  const rawCharacters = seriesSummary.character_bible || [];
  if (!rawCharacters.length) {
    throw new Error('[ScriptWriter] writeCastBible: series summary has no character_bible');
  }

  const cast = [];
  for (const char of rawCharacters) {
    const visualAnchor = await generateCharacterVisualAnchor(char);
    const seed = assignSeedForCharacter(char);
    const voiceId = assignVoiceForCharacter(char);

    cast.push({
      ...char,
      visual_anchor:  visualAnchor,
      seed:           seed,
      voice_id:       voiceId,
      visual_profile: char.visual_profile || {},
    });
    console.log(`[ScriptWriter] Cast locked: ${char.name} → seed=${seed}, voice=${voiceId}`);
  }

  return cast;
}

// ─────────────────────────────────────────────────────────────────────────────
// Character Visual Anchor — immutable physical identity lock
// Now also outputs structured visual_metadata with seed for CF worker.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rewrite a character reference-portrait prompt after a provider content-policy refusal.
 *
 * This is deliberately stricter than the general shot rewriter: the output must be a
 * benign casting/reference photograph containing one adult fictional character, with
 * immutable physical identity details preserved but without sexualized, violent, medical,
 * criminal, or other context that can accidentally trigger a safety classifier.
 */
async function rewriteCharacterPortraitPrompt({ character, visualAnchor, angle = 'front', failedPrompt = '', reason = '', attempt = 1, maxRetries = 5 }) {
  const safeCharacter = character && typeof character === 'object' ? character : {};
  const name = safeCharacter.name || 'fictional character';
  const gender = safeCharacter.gender || safeCharacter.visual_profile?.gender || 'adult person';
  const role = safeCharacter.role || 'fictional film character';
  const angleSpec = {
    front: 'front-facing head-and-shoulders casting portrait',
    three_quarter: 'three-quarter head-and-shoulders casting portrait, approximately 45 degrees',
    profile: 'clean left side-profile head-and-shoulders casting portrait',
    full_body: 'full-length neutral standing casting portrait, both hands visible',
  }[angle] || 'front-facing casting portrait';

  const systemPrompt = `${DIRECTOR_PERSONA}

You are the senior casting photographer and visual continuity supervisor for a fictional film studio.
A character-reference image request was rejected by an automated image-safety filter. Rewrite the prompt into
an exceptionally clear, ordinary, professional casting photograph that is unlikely to be misclassified.

HARD RULES:
- The subject is ONE fictional ADULT PERSON only. Never mention minors or ambiguous age.
- Preserve immutable identity traits: hair, eyes, skin tone/undertone, facial structure, build, posture, and signature wardrobe item.
- Remove all story context that is not visibly necessary: violence, weapons, injury, blood, death, crime, sexuality, nudity, drugs, medical procedures, captivity, abuse, supernatural harm, or threatening behavior.
- No romance, seduction, suggestive posing, exposed body areas, fetish language, or emotionally charged physical interaction.
- Do not mention safety filters, policies, rejection codes, bypassing, moderation, or prompt engineering.
- Describe only visible wardrobe, body posture, facial expression, hairstyle, neutral studio environment, lighting, camera framing, and photorealistic image quality.
- Keep the requested camera angle exactly.
- The image must read like a professional actor headshot / casting reference photograph.
- Use concise, concrete cinematic language. No narrative prose.

Return JSON only with exactly one field: {"rewritten_prompt":"..."}.`;

  const userPrompt = `Character: ${name}
Role: ${role}
Gender: ${gender}
Immutable visual anchor: ${visualAnchor || safeCharacter.description || ''}
Required framing: ${angleSpec}
Retry: ${attempt}/${maxRetries}
Provider refusal reason: ${String(reason || 'content-policy refusal').slice(0, 500)}
Previous prompt:
${String(failedPrompt || '').slice(0, 5000)}

Produce a replacement prompt that keeps the character's immutable identity while making the request a plain,
professional, non-sensitive adult casting portrait. Include 9:16 vertical portrait framing, one person only,
neutral dark studio background, neutral/resting expression, natural closed-mouth pose, soft studio key/fill lighting,
sharp facial detail, realistic skin and hair texture, and no other people, props, text, logos, watermarks, or panels.`;

  const result = await callLLM(systemPrompt, userPrompt, 900, { useStream: false });
  const rewritten = result?.rewritten_prompt;
  if (!rewritten || typeof rewritten !== 'string' || rewritten.trim().length < 40) {
    throw new Error('Director returned no usable character portrait rewrite');
  }
  return rewritten.trim();
}

async function generateCharacterVisualAnchor(character) {
  const systemPrompt = `${DIRECTOR_PERSONA}

You are also the head of the casting department and visual effects supervisor.
Your job: lock down a character's permanent, unwavering physical identity for AI image generation.
Every time this character appears on screen across 80 episodes, they must look EXACTLY the same.

CRITICAL FORMAT RULE: You must output a comma-separated attribute TAG LIST — NOT prose sentences.
Diffusion image models tokenize comma-separated tags individually, giving each trait proper weight.
A prose sentence buries traits in syntax and causes identity drift.`;

  const userPrompt = `Create a permanent visual identity tag-lock for:

Name: ${character.name}
Role: ${character.role || 'unknown'}
Gender: ${character.gender || character.visual_profile?.gender || 'unknown'}
Description: ${character.description}
Visual profile: ${JSON.stringify(character.visual_profile || {})}

Return JSON with one field:
{
  "visual_anchor": "A comma-separated tag list of ONLY immutable physical traits. Under 80 words total. Format: [hair shade + texture + length], [eye colour + shape], [skin tone + undertone], [jaw shape], [cheekbone prominence], [nose shape], [height + build], [posture], [one always-worn signature item]. Use cinematographer-precise language — not 'brown hair' but 'deep espresso-brown loose-wave shoulder-length hair'. Every tag is a direct instruction to an image model — no filler words, no conjunctions, no backstory."
}

FORBIDDEN: prose sentences, personality traits, emotions, backstory, context, conjunctions.
REQUIRED: comma-separated tags only, physical traits only, each tag self-contained.`;

  const result = await callLLM(systemPrompt, userPrompt, 400);
  return result.visual_anchor || `${character.name}: ${character.description}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Episode Script — the director's craft at full depth
// Now receives: locked cast (with voice_id + seed), series comprehensive_summary
// as global context, and builds a narrative_context_history array across scenes.
// ─────────────────────────────────────────────────────────────────────────────

/** Build/repair a complete beginning-to-end story simulation for an existing series. */
async function simulateSeriesStory({ storyline, characters, episodesPerSeason = 8, seasonsPerSeries = 4 }) {
  const stored = storyline?.full_story_simulation
    ? (typeof storyline.full_story_simulation === 'string' ? safeJsonParse(storyline.full_story_simulation, {}) : storyline.full_story_simulation)
    : {};
  const storedTrajectory = Array.isArray(stored.episode_trajectory) ? stored.episode_trajectory : [];

  let master = stored?.opening_state && Array.isArray(stored?.season_endpoints)
    ? stored
    : null;

  if (!master) {
    const systemPrompt = `${DIRECTOR_PERSONA}
You are the continuity showrunner.
Build the series-level continuity frame before episode generation.
Do NOT generate episode-by-episode trajectories in this completion; those are
generated separately in bounded, validated chunks. Return JSON only.`;

    const userPrompt = `Series: "${storyline.title}" (${storyline.genre})
Logline: ${storyline.logline || ''}
Theme: ${storyline.central_theme || ''}
Master summary: ${storyline.comprehensive_summary || storyline.plot_summary || ''}
Season arcs: ${JSON.stringify(storyline.season_arcs || [])}
Cast: ${(characters || []).map(c => `${c.name}: ${c.role}; ${c.description}; arc=${c.arc || ''}`).join('\n')}

Build the authoritative beginning-to-ending continuity frame for exactly
${seasonsPerSeries} seasons with ${episodesPerSeason} episodes each.

Return JSON:
{
  "opening_state": "",
  "inciting_event": "",
  "season_endpoints": ${JSON.stringify(
    Array.from({ length: seasonsPerSeries }, (_, i) => ({
      season: i + 1,
      beginning: '',
      turning_points: ['', '', ''],
      ending: '',
    })),
    null,
    2
  )},
  "episode_trajectory": [],
  "finale_resolution": "",
  "unresolved_threads": []
}

Return exactly ${seasonsPerSeries} season_endpoints in ascending season order, with
each season number from 1 through ${seasonsPerSeries} used exactly once. Leave
episode_trajectory empty.`;
    master = await callLLM(systemPrompt, userPrompt, 4500, { useStream: false });
  } else {
    console.log(`[ScriptWriter] ↺ Resuming series simulation: ${storedTrajectory.length} trajectory checkpoints already durable in DB`);
  }

  master = {
    ...master,
    season_endpoints: _normalizeSeasonEndpoints(
      master?.season_endpoints,
      seasonsPerSeries,
      'Series simulation'
    ),
  };

  const fullCheckpoint = current => ({
    ...master,
    episode_trajectory: current,
    simulation_status: 'in_progress',
    simulation_total_episodes: episodesPerSeason * seasonsPerSeries,
    simulation_completed_episodes: current.length,
  });

  const trajectory = await buildSeriesEpisodeTrajectories({
    masterSimulation: master,
    storyline,
    characters: characters?.length ? characters : (storyline.character_bible ? safeJsonParse(storyline.character_bible, storyline.character_bible) : []),
    episodesPerSeason,
    seasonsPerSeries,
    initialTrajectories: storedTrajectory,
    onChunkLocked: async ({ trajectories, completedChunks, totalChunks }) => {
      await db.execute(
        `UPDATE storylines SET full_story_simulation = ?, updated_at = NOW() WHERE id = ?`,
        [JSON.stringify({ ...fullCheckpoint(trajectories), simulation_completed_chunks: completedChunks, simulation_total_chunks: totalChunks }), storyline.id]
      );
      console.log(`[ScriptWriter] 💾 DB checkpoint persisted: ${trajectories.length}/${episodesPerSeason * seasonsPerSeries} trajectories (${completedChunks}/${totalChunks} chunks)`);
    },
  });

  const finalSimulation = {
    ...master,
    episode_trajectory: trajectory,
    simulation_status: 'complete',
    simulation_total_episodes: episodesPerSeason * seasonsPerSeries,
    simulation_completed_episodes: trajectory.length,
    simulation_completed_chunks: Math.ceil((episodesPerSeason * seasonsPerSeries) / Math.min(5, episodesPerSeason)),
    simulation_total_chunks: Math.ceil((episodesPerSeason * seasonsPerSeries) / Math.min(5, episodesPerSeason)),
  };

  await db.execute(
    `UPDATE storylines SET full_story_simulation = ?, updated_at = NOW() WHERE id = ?`,
    [JSON.stringify(finalSimulation), storyline.id]
  );
  return finalSimulation;
}


/**
 * Episode-level narrative simulation. This fills the missing simulation stage
 * between the full-series simulation and the scene/shot production gates.
 * It is intentionally compact: it locks the episode's causal spine and scene
 * beat count before the actual episode script is written.
 */
async function simulateEpisodeStory({
  storyline,
  characters,
  recentEpisodes = [],
  episodeNumber,
  seasonNumber,
  isFinale = false,
  isSeriesMovie = false,
  targetMinutes = 2,
  sceneCount = null,
  episodeTrajectory = null,
  existingSimulation = null,
  checkpoint = null,
}) {
  const fullStorySimulation = storyline?.full_story_simulation
    ? (typeof storyline.full_story_simulation === 'string'
      ? safeJsonParse(storyline.full_story_simulation, {})
      : storyline.full_story_simulation)
    : {};

  const trajectory = episodeTrajectory || (
    Array.isArray(fullStorySimulation.episode_trajectory)
      ? fullStorySimulation.episode_trajectory.find(ep =>
          Number(ep.season) === Number(seasonNumber) && Number(ep.episode) === Number(episodeNumber)
        )
      : null
  );

  if (!trajectory) {
    throw new Error(`[ScriptWriter] Authoritative episode trajectory missing for S${seasonNumber}E${episodeNumber}`);
  }

  const compactSeriesContext = _buildCompactEpisodeContext({
    storyline,
    fullStorySimulation,
    seasonNumber,
    episodeNumber,
    episodeTrajectory: _compactEpisodeTrajectoryForLLM(trajectory),
    recentEpisodes,
  });

  const resolvedSceneCount = Number(sceneCount) > 0
    ? Number(sceneCount)
    : config.computeExpectedSceneCount({ isSeriesMovie, targetMinutes });

  const prior = existingSimulation && typeof existingSimulation === 'object' ? existingSimulation : {};
  const priorScenes = Array.isArray(prior.scene_beat_plan)
    ? prior.scene_beat_plan
        .filter(sc => Number(sc?.scene_number) >= 1 && Number(sc?.scene_number) <= resolvedSceneCount)
        .sort((a, b) => Number(a.scene_number) - Number(b.scene_number))
    : [];

  const completedByNumber = new Map(priorScenes.map(sc => [Number(sc.scene_number), sc]));
  const scenePlan = [];

  // Keep only a contiguous completed prefix. A stray later scene cannot become
  // the predecessor for a scene that still needs to be simulated.
  for (let n = 1; n <= resolvedSceneCount; n++) {
    const priorScene = completedByNumber.get(n);
    if (!priorScene || !priorScene.opening_state || !priorScene.closing_state || !priorScene.handoff_to_next_scene) break;
    scenePlan.push(priorScene);
  }

  const priorOpening = _compactLLMText(prior.opening_state || trajectory.opening || '', 900);
  const priorEnding = _compactLLMText(prior.ending_state || trajectory.ending || '', 900);
  const previousClosing = () => scenePlan.length ? scenePlan[scenePlan.length - 1].closing_state : priorOpening;

  const phaseFor = (n) => {
    const ratio = n / resolvedSceneCount;
    if (n === 1) return 'opening / inciting movement';
    if (ratio <= 0.25) return 'early escalation';
    if (ratio <= 0.55) return 'rising pressure / midpoint';
    if (ratio <= 0.8) return 'crisis / reversal';
    if (n === resolvedSceneCount) return 'climax / ending / next hook';
    return 'late escalation';
  };

  const repairEpisodeScene = async ({ sceneNo, priorState, rawScene, missingFields }) => {
    const safeRaw = rawScene && typeof rawScene === 'object' ? rawScene : {};
    const repairSystem = `${DIRECTOR_PERSONA}\nYou are repairing a single scene-simulation JSON object. Return JSON only. Preserve all valid facts; fill only missing/empty required fields. Do not invent facts outside the supplied episode trajectory and inherited state.`;
    const repairPrompt = `
SCENE: ${sceneNo}
MISSING REQUIRED FIELDS: ${missingFields.join(', ')}
INHERITED STATE: ${_compactLLMText(priorState || '', 1200)}
CURRENT SCENE JSON:
${JSON.stringify(safeRaw).slice(0, 10000)}

Return exactly this object shape and keep every supplied valid value:
{
  "scene_number": ${sceneNo},
  "purpose": "...",
  "opening_state": "...",
  "causal_event": "...",
  "character_state_changes": ["..."],
  "environment_state_changes": ["..."],
  "dialogue_intent": "...",
  "wardrobe_context": {"Character Name":"exact wardrobe context for this scene"},
  "wardrobe_change_plan": [],
  "location_transition": "none | within_location | departure | transit | arrival",
  "origin_location": "...",
  "destination_location": "...",
  "travel_mode": "walk | run | drive | ride | train | bus | bike | boat | aircraft | stairs | elevator | other | none",
  "route_beats": ["..."],
  "closing_state": "...",
  "handoff_to_next_scene": "..."
}

The closing_state must be concrete. The handoff_to_next_scene must state the exact continuity fact the next scene inherits. Do not add prose outside JSON.`;
    return callLLM(repairSystem, repairPrompt, undefined, { useStream: false, temperature: 0.1 });
  };

  for (let sceneNo = scenePlan.length + 1; sceneNo <= resolvedSceneCount; sceneNo++) {
    const priorScene = scenePlan.length ? scenePlan[scenePlan.length - 1] : null;
    const priorState = priorScene?.closing_state || priorOpening;
    const phase = phaseFor(sceneNo);

    const systemPrompt = `${DIRECTOR_PERSONA}\nYou are the continuity architect for ONE scene inside a locked cinematic episode.\nReturn JSON only. Simulate exactly one scene; do not simulate later scenes.\nThe authoritative episode trajectory is fixed. The scene must inherit the prior scene state and hand off a concrete state to the next scene.`;

    const userPrompt = `
SERIES: ${storyline?.title || ''}
GENRE: ${storyline?.genre || ''}
EPISODE: S${seasonNumber}E${episodeNumber}
SCENE: ${sceneNo} of ${resolvedSceneCount}
SCENE PHASE: ${phase}
TARGET RUNTIME: ~${targetMinutes} minutes
FINALE: ${!!isFinale}
SERIES MOVIE: ${!!isSeriesMovie}

AUTHORITATIVE EPISODE TRAJECTORY:
${JSON.stringify(_compactEpisodeTrajectoryForLLM(trajectory))}

COMPACT SERIES CONTEXT:
${JSON.stringify(compactSeriesContext)}

CURRENT EPISODE OPENING STATE:
${priorOpening}

CURRENT EPISODE ENDING TARGET:
${priorEnding}

INHERITED STATE FROM PRIOR SCENE:
${_compactLLMText(priorState, 1100)}

CAST:
${(characters || []).map(c => `${c.name}: ${c.role}; ${_compactLLMText(c.description || '', 700)}`).join('\n')}

Create ONLY SCENE ${sceneNo}. It must causally advance the authoritative episode trajectory.
Do not invent a new episode ending, contradict the trajectory, or jump over the inherited state.
${sceneNo === 1 ? 'Establish the opening state and begin the inciting movement.' : ''}
${sceneNo === resolvedSceneCount ? 'Land the episode on the authoritative ending/cliffhanger trajectory.' : ''}

Return exactly:
{
  "scene_number": ${sceneNo},
  "purpose": "...",
  "opening_state": "...",
  "causal_event": "...",
  "character_state_changes": ["..."],
  "environment_state_changes": ["..."],
  "dialogue_intent": "...",
  "wardrobe_context": {"Character Name":"exact wardrobe context for this scene"},
  "wardrobe_change_plan": [],
  "location_transition": "none | within_location | departure | transit | arrival",
  "origin_location": "...",
  "destination_location": "...",
  "travel_mode": "...",
  "route_beats": ["..."],
  "closing_state": "...",
  "handoff_to_next_scene": "..."
}

Rules:
- scene_number must be ${sceneNo}
- opening_state must inherit the supplied prior state
- closing_state must be a concrete state, not a vague promise
- handoff_to_next_scene must state exactly what the next scene inherits
- WARDROBE: wardrobe_context must carry the scene's intended worn state for each relevant character.
- wardrobe_change_plan may contain only changes that are narratively required; every planned change must identify character, from, to, and the fact that the change must be shown live in a dedicated shot.
- A wardrobe change must never be expressed as an unexplained instant jump between scene states.
- location_transition must identify whether this scene is stationary, departure, transit, or arrival
- if the destination differs from the prior scene/location, do not skip the physical travel process
- route_beats must contain concrete visible travel beats when movement between locations matters
- preserve character, location, prop, costume, time and causal continuity
- WARDROBE CONTINUITY: inherit each character's current wardrobe from the previous scene/shot unless the story explicitly requires a change.
- Any required wardrobe change must be planned as a visible live clothing-change event in the scene, never as an unexplained instant replacement between shots.
- if this scene begins or ends in a different location, explicitly plan departure/transit/arrival
- do not use a bare location change as a substitute for travel
- route_beats must describe visible physical movement when travel is narratively relevant
- do not write final shot prompts or production JSON
`;

    const result = await callLLM(systemPrompt, userPrompt, undefined, { useStream: false, temperature: 0.2 });
    const rawScene = result?.scene && typeof result.scene === 'object' ? result.scene : result;
    if (!rawScene || typeof rawScene !== 'object') {
      throw new Error(`[ScriptWriter] Episode scene simulation invalid for S${seasonNumber}E${episodeNumber}: scene ${sceneNo} missing object`);
    }

    const scene = {
      ...rawScene,
      scene_number: sceneNo,
      purpose: _compactLLMText(rawScene.purpose || '', 1000),
      opening_state: _compactLLMText(rawScene.opening_state || priorState || '', 1100),
      causal_event: _compactLLMText(rawScene.causal_event || '', 1200),
      character_state_changes: Array.isArray(rawScene.character_state_changes)
        ? rawScene.character_state_changes.slice(0, 8).map(x => _compactLLMText(x, 350))
        : [],
      environment_state_changes: Array.isArray(rawScene.environment_state_changes)
        ? rawScene.environment_state_changes.slice(0, 8).map(x => _compactLLMText(x, 350))
        : [],
      dialogue_intent: _compactLLMText(rawScene.dialogue_intent || '', 700),
      location_transition: String(rawScene.location_transition || 'none').trim().toLowerCase(),
      origin_location: _compactLLMText(rawScene.origin_location || rawScene.location || '', 500),
      destination_location: _compactLLMText(rawScene.destination_location || rawScene.location || '', 500),
      travel_mode: String(rawScene.travel_mode || 'none').trim().toLowerCase(),
      route_beats: Array.isArray(rawScene.route_beats)
        ? rawScene.route_beats.slice(0, 6).map(x => _compactLLMText(x, 300))
        : [],
      closing_state: _compactLLMText(rawScene.closing_state || '', 1100),
      handoff_to_next_scene: _compactLLMText(rawScene.handoff_to_next_scene || '', 1100),
    };

    const missingFields = ['opening_state', 'closing_state', 'handoff_to_next_scene']
      .filter(field => !String(scene[field] || '').trim());

    if (missingFields.length) {
      console.warn(`[ScriptWriter] Scene ${sceneNo} failed structural validation; attempting one bounded repair for: ${missingFields.join(', ')}`);
      let repaired;
      try {
        repaired = await repairEpisodeScene({ sceneNo, priorState, rawScene, missingFields });
      } catch (repairErr) {
        throw new Error(`[ScriptWriter] Episode scene simulation invalid: scene ${sceneNo} missing ${missingFields.join(', ')}; repair failed: ${repairErr.message}`);
      }

      const repairedScene = repaired?.scene && typeof repaired.scene === 'object' ? repaired.scene : repaired;
      if (repairedScene && typeof repairedScene === 'object') {
        scene.opening_state = _compactLLMText(repairedScene.opening_state || scene.opening_state || priorState || '', 1100);
        scene.closing_state = _compactLLMText(repairedScene.closing_state || scene.closing_state || '', 1100);
        scene.handoff_to_next_scene = _compactLLMText(repairedScene.handoff_to_next_scene || scene.handoff_to_next_scene || '', 1100);
        scene.purpose = _compactLLMText(repairedScene.purpose || scene.purpose || '', 1000);
        scene.causal_event = _compactLLMText(repairedScene.causal_event || scene.causal_event || '', 1200);
        scene.dialogue_intent = _compactLLMText(repairedScene.dialogue_intent || scene.dialogue_intent || '', 700);
        scene.location_transition = String(repairedScene.location_transition || scene.location_transition || 'none').trim().toLowerCase();
        scene.origin_location = _compactLLMText(repairedScene.origin_location || scene.origin_location || '', 500);
        scene.destination_location = _compactLLMText(repairedScene.destination_location || scene.destination_location || '', 500);
        scene.travel_mode = String(repairedScene.travel_mode || scene.travel_mode || 'none').trim().toLowerCase();
        if (Array.isArray(repairedScene.route_beats)) scene.route_beats = repairedScene.route_beats.slice(0, 6).map(x => _compactLLMText(x, 300));
        if (Array.isArray(repairedScene.character_state_changes)) {
          scene.character_state_changes = repairedScene.character_state_changes.slice(0, 8).map(x => _compactLLMText(x, 350));
        }
        if (Array.isArray(repairedScene.environment_state_changes)) {
          scene.environment_state_changes = repairedScene.environment_state_changes.slice(0, 8).map(x => _compactLLMText(x, 350));
        }
      }
    }

    const stillMissing = ['opening_state', 'closing_state', 'handoff_to_next_scene']
      .filter(field => !String(scene[field] || '').trim());
    if (stillMissing.length) {
      throw new Error(`[ScriptWriter] Episode scene simulation invalid: scene ${sceneNo} missing state/handoff after repair (${stillMissing.join(', ')})`);
    }

    // Verify the causal chain locally before checkpointing the scene.
    if (sceneNo > 1 && !scene.opening_state.trim()) {
      throw new Error(`[ScriptWriter] Episode scene simulation invalid: empty inherited opening state at scene ${sceneNo}`);
    }

    scenePlan.push(scene);

    const partial = {
      episode: { season: Number(seasonNumber), episode: Number(episodeNumber) },
      opening_state: priorOpening,
      ending_state: priorEnding,
      scene_beat_plan: scenePlan.slice(),
      continuity_invariants: Array.isArray(prior.continuity_invariants)
        ? prior.continuity_invariants
        : (Array.isArray(trajectory.character_changes) ? trajectory.character_changes.slice(0, 8) : []),
      unresolved_threads: Array.isArray(prior.unresolved_threads)
        ? prior.unresolved_threads
        : [],
      simulation_status: scenePlan.length >= resolvedSceneCount ? 'complete' : 'in_progress',
      completed_scene_numbers: scenePlan.map(sc => Number(sc.scene_number)),
      total_scene_numbers: resolvedSceneCount,
    };

    if (typeof checkpoint === 'function') {
      await checkpoint({
        stage: 'episode_scene_simulation',
        sceneNumber: sceneNo,
        simulation: partial,
      });
      console.log(`[Pipeline] 💾 Episode scene-simulation checkpoint persisted: S${seasonNumber}E${episodeNumber} scene ${sceneNo}/${resolvedSceneCount}`);
    }
  }

  const finalSimulation = {
    episode: { season: Number(seasonNumber), episode: Number(episodeNumber) },
    opening_state: priorOpening,
    ending_state: priorEnding,
    scene_beat_plan: scenePlan,
    continuity_invariants: Array.isArray(prior.continuity_invariants)
      ? prior.continuity_invariants
      : (Array.isArray(trajectory.character_changes) ? trajectory.character_changes.slice(0, 8) : []),
    unresolved_threads: Array.isArray(prior.unresolved_threads) ? prior.unresolved_threads : [],
    simulation_status: 'complete',
    completed_scene_numbers: scenePlan.map(sc => Number(sc.scene_number)),
    total_scene_numbers: resolvedSceneCount,
  };

  console.log(`[ScriptWriter] Episode scene simulation locked: ${scenePlan.length} scenes.`);
  return finalSimulation;
}

/**
 * Hard pre-generation shot simulation.
 * Simulates the complete ordered shot trajectory for the episode before any
 * image/video generation begins. The result is a locked causal plan used by
 * every scene shot-writing pass.
 */
async function simulateEpisodeShots({
  storyline,
  characters,
  episodeSimulation,
  sceneSimulation = null,
  scenes,
  episodeNumber,
  seasonNumber,
  targetMinutes,
  existingShotSimulation = null,
  checkpoint = null,
}) {
  const plannedScenes = Array.isArray(scenes) ? scenes : [];
  const castNames = (characters || []).map(c => c.name).filter(Boolean);

  const counts = Object.fromEntries(plannedScenes.map(sc => [
    Number(sc.scene_number),
    Math.max(2, Math.min(5, Number(sc.shot_count_target) || 3)),
  ]));

  const existing = existingShotSimulation && typeof existingShotSimulation === 'object'
    ? existingShotSimulation
    : {};
  const existingShots = Array.isArray(existing.shots) ? existing.shots : [];
  const normalizedExisting = [];

  const idsMatchPlan = (shots, sceneNo, target) =>
    Array.isArray(shots) &&
    shots.length === target &&
    shots.every((shot, i) => Number(shot?.scene_number) === sceneNo && Number(shot?.shot_index) === i + 1);

  // Persisted shot-simulation IDs are authoritative. Never renumber a checkpoint.
  for (const scene of plannedScenes) {
    const sceneNo = Number(scene.scene_number);
    const target = counts[sceneNo];
    const prior = existingShots
      .filter(s => Number(s.scene_number) === sceneNo)
      .sort((a, b) => Number(a.shot_index) - Number(b.shot_index));

    if (idsMatchPlan(prior, sceneNo, target)) {
      normalizedExisting.push(...prior);
      console.log(`[ScriptWriter] ↺ Restored shot simulation checkpoint S${seasonNumber}E${episodeNumber} scene ${sceneNo} (${target}/${target} shots)`);
    } else if (prior.length) {
      console.warn(`[ScriptWriter] Invalid persisted shot-simulation IDs for S${seasonNumber}E${episodeNumber} scene ${sceneNo}; ignoring that scene checkpoint and regenerating it from scene simulation.`);
    }
  }

  const working = {
    episode: { season: Number(seasonNumber), episode: Number(episodeNumber) },
    global_start_state: existing.global_start_state || episodeSimulation?.opening_state || '',
    global_end_state: existing.global_end_state || episodeSimulation?.ending_state || '',
    shots: normalizedExisting.slice(),
    continuity_invariants: Array.isArray(existing.continuity_invariants)
      ? existing.continuity_invariants
      : (episodeSimulation?.continuity_invariants || []),
    unresolved_threads_at_end: Array.isArray(existing.unresolved_threads_at_end)
      ? existing.unresolved_threads_at_end
      : (episodeSimulation?.unresolved_threads || []),
  };

  const simulatedScenes = Array.isArray(sceneSimulation?.scene_beat_plan)
    ? sceneSimulation.scene_beat_plan
    : [];

  const getPreviousShot = (sceneNo) => {
    const sameScene = working.shots
      .filter(s => Number(s.scene_number) === Number(sceneNo))
      .sort((a, b) => Number(a.shot_index) - Number(b.shot_index));
    if (sameScene.length) return sameScene[sameScene.length - 1];
    return null;
  };

  for (let scenePos = 0; scenePos < plannedScenes.length; scenePos++) {
    const scene = plannedScenes[scenePos];
    const sceneNo = Number(scene.scene_number);
    const target = counts[sceneNo];
    const already = working.shots.filter(s => Number(s.scene_number) === sceneNo);
    if (already.length === target && idsMatchPlan(already.slice().sort((a,b)=>Number(a.shot_index)-Number(b.shot_index)), sceneNo, target)) continue;

    const rawSim = simulatedScenes.find(s => Number(s.scene_number) === sceneNo) || {};
    const compactSceneSimulation = {
      scene_number: sceneNo,
      purpose: _compactLLMText(rawSim.purpose || scene.scene_description || '', 700),
      opening_state: _compactLLMText(rawSim.opening_state || '', 800),
      causal_event: _compactLLMText(rawSim.causal_event || '', 900),
      character_state_changes: Array.isArray(rawSim.character_state_changes)
        ? rawSim.character_state_changes.slice(0, 6).map(x => _compactLLMText(x, 300)) : [],
      environment_state_changes: Array.isArray(rawSim.environment_state_changes)
        ? rawSim.environment_state_changes.slice(0, 6).map(x => _compactLLMText(x, 300)) : [],
      dialogue_intent: _compactLLMText(rawSim.dialogue_intent || '', 600),
      wardrobe_context: rawSim.wardrobe_context || {},
      wardrobe_change_plan: Array.isArray(rawSim.wardrobe_change_plan) ? rawSim.wardrobe_change_plan.slice(0, 8) : [],
      location_transition: String(rawSim.location_transition || 'none').trim().toLowerCase(),
      origin_location: _compactLLMText(rawSim.origin_location || scene.location || '', 500),
      destination_location: _compactLLMText(rawSim.destination_location || scene.location || '', 500),
      travel_mode: String(rawSim.travel_mode || 'none').trim().toLowerCase(),
      route_beats: Array.isArray(rawSim.route_beats) ? rawSim.route_beats.slice(0, 6).map(x => _compactLLMText(x, 260)) : [],
      closing_state: _compactLLMText(rawSim.closing_state || '', 800),
      handoff_to_next_scene: _compactLLMText(rawSim.handoff_to_next_scene || '', 800),
    };

    const previousShot = getPreviousShot(sceneNo);
    const sceneOpeningState = previousShot
      ? (previousShot.handoff_to_next || previousShot.end_state || compactSceneSimulation.opening_state)
      : (compactSceneSimulation.opening_state || episodeSimulation?.opening_state || '');

    const systemPrompt = `${DIRECTOR_PERSONA}\n${MULTI_SPEAKER_LTX_RULES}\nYou are the continuity director performing a PRE-GENERATION SHOT SIMULATION for ONE SCENE.\nDo not write prose outside JSON. Do not generate images, videos, or final prompts.\nThis scene is part of a locked cinematic episode. Preserve the causal state handed into the scene\nand produce exactly the requested number of sequential local shots.`;

    const userPrompt = `
SERIES: ${_compactLLMText(storyline.title || '', 300)}
EPISODE: S${seasonNumber}E${episodeNumber}
SCENE: ${sceneNo}
SCENE POSITION: ${scenePos + 1} of ${plannedScenes.length}
TARGET RUNTIME: ~${targetMinutes} minutes
EXPECTED SHOTS FOR THIS SCENE: ${target}
CAST: ${castNames.join(', ')}

EPISODE OPENING STATE:
${_compactLLMText(episodeSimulation?.opening_state || '', 900)}

CURRENT SCENE BLUEPRINT:
${JSON.stringify({
      scene_number: sceneNo,
      scene_description: _compactLLMText(scene.scene_description || '', 800),
      emotional_beat: _compactLLMText(scene.emotional_beat || '', 600),
      location: _compactLLMText(scene.location || '', 400),
      lighting_design: _compactLLMText(scene.lighting_design || '', 400),
      camera_language: _compactLLMText(scene.camera_language || '', 500),
      characters_present: scene.characters_present || [],
      shot_count_target: target,
      wardrobe_context: scene.wardrobe_context || scene.wardrobe_states || scene.character_wardrobe || {},
    })}

LOCKED SCENE SIMULATION:
${JSON.stringify(compactSceneSimulation)}

STATE INHERITED FROM PREVIOUS SHOT IN THIS SAME SCENE:
${JSON.stringify(previousShot ? {
      scene_number: previousShot.scene_number,
      shot_index: previousShot.shot_index,
      end_state: previousShot.end_state || '',
      handoff_to_next: previousShot.handoff_to_next || '',
    } : { opening_state: sceneOpeningState })}

Produce exactly ${target} shots for SCENE ${sceneNo}.
The first shot MUST begin from the inherited state above.
Each subsequent shot MUST inherit the immediately previous shot's end_state/handoff.
The final shot MUST end on the scene's locked closing state or a concrete state that causally leads to it.

Return exactly:
{
  "scene_number": ${sceneNo},
  "shots": [
    {
      "scene_number": ${sceneNo},
      "shot_index": 1,
      "purpose": "...",
      "start_state": "...",
      "action_arc": "...",
      "dialogue_intent": "spoken|internal_monologue|ambient|phone_vo",
      "speaker": "Exact character name from CAST; REQUIRED and NON-EMPTY for spoken, phone_vo, or internal_monologue shots; empty ONLY for ambient/action-only shots",
      "dialogue_purpose": "what must be said/heard, without inventing exact final wording",
      "character_state_change": "...",
      "environment_state_change": "...",
      "wardrobe_states": {"Character Name":"exact wardrobe state currently worn"},
      "wardrobe_change": null,
      "location_transition": "none | departure | transit | arrival",
      "travel_stage": "none | prepare | depart | in_transit | approach | arrive",
      "origin_location": "...",
      "destination_location": "...",
      "travel_mode": "walk | drive | ride | train | bus | bike | boat | aircraft | stairs | elevator | none",
      "route_beat": "One concrete visible movement beat that changes spatial position, or empty if stationary.",
      "end_state": "...",
      "handoff_to_next": "exact continuity fact the next shot must inherit"
    }
  ]
}

HARD REQUIREMENTS:
- Exactly ${target} shots.
- All shots belong to scene ${sceneNo}.
- Shot indices are scene-local and serial: 1, 2, 3... ${target}.
- Do NOT use episode-global shot numbering.
- Do NOT skip or duplicate a local index.
- Do NOT change scene number.
- Do NOT introduce new characters, locations, props, time jumps, or costume changes unsupported by the locked scene.
- WARDROBE CONTRACT: every shot inherits the prior shot's wardrobe for every character unless a change is explicitly authorized.
- A wardrobe change is NEVER a silent jump between two stills. It must be represented by a dedicated shot whose wardrobe_change names every changing character and contains a visible live action showing that character removing/donning/changing clothing.
- Each changing character must have an explicit from wardrobe, to wardrobe, and visible change action. Do not mark a wardrobe change for a character who is not visibly present and actively changing in that shot.
- Once the dedicated change shot completes, all following shots inherit the new wardrobe until another explicitly authorized live change occurs.
- Never alter wardrobe merely because the shot type, location, lighting, dialogue, action, or camera angle changes.
- SPEAKER CONTRACT: when dialogue_intent is spoken, phone_vo, or internal_monologue, speaker MUST be a specific named character from CAST and MUST NOT be empty.
- NEVER output speaker="" for an audible shot.
- If multiple characters are present, determine the intended speaker from the locked scene context, character staging, and dialogue_purpose; do not guess an unrelated character.
- speakers_in_shot must list every speaker in chronological order when a shot contains multiple dialogue turns.
- An audible shot with missing/ambiguous speaker metadata is INVALID and must be repaired before it can be checkpointed.
- If the scene moves between locations, the first shot must begin at the true origin state, intermediate shots must depict physical transit, and the destination must appear only at the appropriate arrival stage.
- A destination may not be used as the opening image of a departure or transit shot.
- Preserve the emotional and causal progression.
`;

    let result = await callLLM(systemPrompt, userPrompt, undefined, { useStream: false, temperature: 0.2 });
    let repairAttempt = 0;
    const maxRepairAttempts = 3;
    while (repairAttempt < maxRepairAttempts) {
      const rawShots = Array.isArray(result?.shots) ? result.shots : [];
      if (idsMatchPlan(rawShots, sceneNo, target)) break;

      repairAttempt += 1;
      const expectedIds = Array.from({ length: target }, (_, i) => `S${sceneNo}/${i + 1}`);
      const returnedIds = rawShots.map(s => `S${Number.isFinite(Number(s?.scene_number)) ? Number(s.scene_number) : 'n/a'}/${Number.isFinite(Number(s?.shot_index)) ? Number(s.shot_index) : 'n/a'}`);
      const validationError = !rawShots.length
        ? `Scene S${sceneNo} returned no usable shot objects. The authoritative plan requires ${target} ordered shots with IDs ${expectedIds.join(', ')}.`
        : `Scene S${sceneNo} requires exact local IDs ${expectedIds.join(', ')} in this order; model returned ${JSON.stringify(returnedIds)}.`;
      console.warn(`[ScriptWriter] Shot simulation mismatch S${sceneNo}: ${validationError} repairAttempt=${repairAttempt}`);

      if (rawShots.length !== target) {
        // A missing/empty/malformed payload cannot be repaired by an ID-only patch.
        // Ask Agnes AI to regenerate this scene's shot simulation, with the exact validation error.
        result = await callLLM(
          `${systemPrompt}\nThe previous response failed validation. Regenerate the complete shot simulation for this scene only. Do not change the story plan.`,
          `${userPrompt}\n\nVALIDATION ERROR FROM PREVIOUS RESPONSE:\n${validationError}\n\nRegenerate the complete JSON for this scene. Do not return an empty shots array.`,
          undefined,
          { useStream: false, temperature: 0.12 }
        );
        continue;
      }

      // The payload exists but its identifiers are wrong. Repair ONLY the identity,
      // preserving the already-generated cinematic/causal content and shot order.
      const repaired = await callLLM(
        `${DIRECTOR_PERSONA}\nYou are repairing ONLY shot identifiers for one already-authored shot simulation. Return JSON only. Preserve all shot content and order.`,
        `SCENE: S${sceneNo}\nEXPECTED PERSISTED IDS: ${JSON.stringify(expectedIds)}\nVALIDATION ERROR: ${validationError}\n\nReturn ONLY {"corrected_ids":[{"position":1,"scene_number":${sceneNo},"shot_index":1}, ...]} with exactly ${target} entries.`,
        undefined,
        { useStream: false, temperature: 0.02 }
      );

      const corrected = Array.isArray(repaired?.corrected_ids) ? repaired.corrected_ids : [];
      const usable = corrected.length === target && corrected.every((id, i) =>
        Number(id?.position) === i + 1 &&
        Number(id?.scene_number) === sceneNo &&
        Number(id?.shot_index) === i + 1
      );

      if (usable) {
        result = { ...result, shots: rawShots.map((shot, i) => ({
          ...shot,
          scene_number: sceneNo,
          shot_index: i + 1,
        })) };
      } else {
        console.warn(`[ScriptWriter] Shot-ID repair returned unusable corrected_ids; preserving the previous usable shot payload for the next retry.`);
      }
    }
    if (!idsMatchPlan(result?.shots, sceneNo, target)) {
      throw new Error(
        `[ScriptWriter] Shot simulation IDs for Scene S${sceneNo} remain invalid after ` +
        `${maxRepairAttempts} bounded repair attempts.`
      );
    }

    const sceneShots = [];
    for (let shotPos = 0; shotPos < result.shots.length; shotPos++) {
      const targetScene = plannedScenes.find(sc => Number(sc.scene_number) === sceneNo) || null;
      const resolvedShot = await _resolveShotSpeakerWithRepair(result.shots[shotPos], targetScene, characters, {
        sceneNo, shotIndex: shotPos + 1, callLLM,
      });
      sceneShots.push(resolvedShot);
    }

    const shotSimulationScenes = plannedScenes.map(sc => ({
      ...sc,
      ...(simulatedScenes.find(ss => Number(ss.scene_number) === Number(sc.scene_number)) || {}),
    }));
    const previewSimulation = directorialOrchestrator.applyToShotSimulation(
      {
        episode: working.episode,
        global_start_state: working.global_start_state,
        global_end_state: working.global_end_state,
        continuity_invariants: working.continuity_invariants,
        unresolved_threads_at_end: working.unresolved_threads_at_end,
        shots: [...working.shots.filter(s => Number(s.scene_number) !== sceneNo), ...sceneShots],
      },
      shotSimulationScenes,
      working.episode
    );
    const repairedShots = [];
    for (const shot of previewSimulation.shots) {
      const targetScene = plannedScenes.find(sc => Number(sc.scene_number) === Number(shot.scene_number)) || null;
      repairedShots.push(await _resolveShotSpeechWithRepair(shot, targetScene, characters, {
        sceneNo: shot.scene_number, shotIndex: shot.shot_index,
      }));
    }
    working.shots = repairedShots;
    working.shots.sort((a, b) => Number(a.scene_number) - Number(b.scene_number) || Number(a.shot_index) - Number(b.shot_index));

    if (typeof checkpoint === 'function') {
      await checkpoint({
        stage: 'shot_simulation',
        sceneNumber: sceneNo,
        completedScenes: plannedScenes
          .filter(s => idsMatchPlan(working.shots.filter(x => Number(x.scene_number) === Number(s.scene_number)).sort((a,b)=>Number(a.shot_index)-Number(b.shot_index)), Number(s.scene_number), counts[Number(s.scene_number)]))
          .map(s => Number(s.scene_number)),
        shotSimulation: working,
      });
      console.log(`[Pipeline] 💾 Shot-simulation checkpoint persisted: S${seasonNumber}E${episodeNumber} scene ${sceneNo}/${plannedScenes.length}`);
    }
  }

  return working;
}


function _compactLLMText(value, maxChars = 3000) {
  const text = value == null ? '' : String(value);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n[context truncated for provider budget]';
}

/**
 * Compacts the full simulated scene_beat_plan for inclusion in the script-writing
 * prompt. Every scene is always represented, all the way to the resolution — this
 * used to `.slice(0, 12)`, which silently dropped any scene past #12 (including
 * the ending) from the writer's context on every movie/long episode, regardless
 * of how many scenes were actually simulated. A writer that can't see its own
 * ending can't write a coherent one. If the full plan would be too large for the
 * prompt budget, per-field detail shrinks progressively instead of dropping
 * scenes outright, since a terser early beat is far less costly than an invisible
 * final act.
 */
function _compactSceneBeatPlan(scenes, { maxTotalChars = 14000 } = {}) {
  if (!Array.isArray(scenes) || !scenes.length) return [];
  const fieldCaps = [300, 220, 170, 130, 100, 80, 65, 50, 40];
  let compact = scenes;
  for (const cap of fieldCaps) {
    compact = scenes.map(scene => ({
      scene_number: Number(scene?.scene_number || 0),
      purpose: _compactLLMText(scene?.purpose || '', cap),
      opening_state: _compactLLMText(scene?.opening_state || '', cap),
      causal_event: _compactLLMText(scene?.causal_event || '', Math.round(cap * 1.3)),
      character_state_changes: Array.isArray(scene?.character_state_changes)
        ? scene.character_state_changes.slice(0, 3).map(x => _compactLLMText(x, Math.round(cap * 0.6)))
        : [],
      environment_state_changes: Array.isArray(scene?.environment_state_changes)
        ? scene.environment_state_changes.slice(0, 3).map(x => _compactLLMText(x, Math.round(cap * 0.6)))
        : [],
      dialogue_intent: _compactLLMText(scene?.dialogue_intent || '', cap),
      closing_state: _compactLLMText(scene?.closing_state || '', cap),
      handoff_to_next_scene: _compactLLMText(scene?.handoff_to_next_scene || '', cap),
    }));
    if (JSON.stringify(compact).length <= maxTotalChars) break;
  }
  return compact;
}

function _compactEpisodeTrajectoryForLLM(trajectory) {
  if (!trajectory || typeof trajectory !== 'object') return null;
  return {
    global_episode: Number(trajectory.global_episode || 0),
    season: Number(trajectory.season || 0),
    episode: Number(trajectory.episode || 0),
    opening: _compactLLMText(trajectory.opening || '', 700),
    inciting: _compactLLMText(trajectory.inciting || '', 800),
    middle_turn: _compactLLMText(trajectory.middle_turn || '', 800),
    climax: _compactLLMText(trajectory.climax || '', 800),
    ending: _compactLLMText(trajectory.ending || '', 700),
    next_hook: _compactLLMText(trajectory.next_hook || '', 700),
    character_changes: Array.isArray(trajectory.character_changes)
      ? trajectory.character_changes.slice(0, 8).map(x => _compactLLMText(x, 350))
      : [],
  };
}

function _buildCompactEpisodeContext({ storyline, fullStorySimulation, seasonNumber, episodeNumber, episodeTrajectory, recentEpisodes = [] }) {
  const master = fullStorySimulation && typeof fullStorySimulation === 'object' ? fullStorySimulation : {};
  const endpoints = Array.isArray(master.season_endpoints) ? master.season_endpoints : [];
  const seasonEndpoint = endpoints.find(e => Number(e?.season) === Number(seasonNumber)) || {};
  const unresolved = Array.isArray(master.unresolved_threads) ? master.unresolved_threads.slice(-8) : [];
  const recent = (recentEpisodes || []).slice(-4).map(e => {
    const sc = safeJsonParse(e.script, {});
    return {
      season: Number(e.season_number || 1),
      episode: Number(e.episode_number || 0),
      summary: _compactLLMText(sc.updated_plot_summary || sc.logline || '', 700),
      handoff: _compactLLMText(sc.director_vision || '', 500),
    };
  });

  return {
    title: storyline?.title || '',
    logline: _compactLLMText(storyline?.logline || '', 700),
    theme: _compactLLMText(storyline?.central_theme || '', 700),
    series_summary: _compactLLMText(storyline?.comprehensive_summary || storyline?.plot_summary || '', 5000),
    season_arc: _compactLLMText(
      Array.isArray(storyline?.season_arcs)
        ? (storyline.season_arcs[Number(seasonNumber) - 1] || '')
        : (typeof storyline?.season_arcs === 'string' ? storyline.season_arcs : ''),
      1800
    ),
    series_opening_state: _compactLLMText(master.opening_state || '', 700),
    inciting_event: _compactLLMText(master.inciting_event || '', 900),
    season_endpoint: {
      beginning: _compactLLMText(seasonEndpoint.beginning || '', 700),
      turning_points: Array.isArray(seasonEndpoint.turning_points) ? seasonEndpoint.turning_points.slice(0, 4).map(x => _compactLLMText(x, 500)) : [],
      ending: _compactLLMText(seasonEndpoint.ending || '', 900),
    },
    finale_resolution: _compactLLMText(master.finale_resolution || '', 900),
    unresolved_threads: unresolved.map(x => _compactLLMText(x, 400)),
    target_episode: {
      season: Number(seasonNumber),
      episode: Number(episodeNumber),
      trajectory: episodeTrajectory || null,
    },
    recent_episodes: recent,
  };
}

const CHECKPOINT_STAGE_ORDER = Object.freeze({
  blueprint: 10,
  shot_simulation: 20,
  shot_simulation_complete: 30,
  scene_shot_writing: 40,
  script_complete: 50,
  script_ready_for_processing: 60,
  simulation_chain_locked: 70,
  media_generation_ready: 80,
});

function _checkpointStageRank(stage) {
  return CHECKPOINT_STAGE_ORDER[String(stage || '').toLowerCase()] || 0;
}

function _hasPersistedProductionBlueprint(existingScript) {
  if (!existingScript || !Array.isArray(existingScript.scenes) || !existingScript.scenes.length) return false;
  const rank = _checkpointStageRank(existingScript?.checkpoint_state?.stage);
  return rank >= CHECKPOINT_STAGE_ORDER.blueprint ||
    Boolean(existingScript.episode_title || existingScript.director_vision || existingScript.episode_number != null);
}

async function writeEpisodeScript({
  storyline,
  characters,
  recentEpisodes,
  episodeNumber,
  seasonNumber,
  isFinale,
  isSeriesMovie,
  targetMinutes,
  runtimeRetryNote = null,
  narrativeSimulation = null,
  existingScript = null,
  checkpoint = null,
}) {
  const systemPrompt = `${DIRECTOR_PERSONA}
You are writing and directing Episode ${episodeNumber} of Season ${seasonNumber} of "${storyline.title}".
You know this story inside out. You have a specific visual and emotional plan for this episode.
Write with the confidence of a showrunner who is in full creative control.
Blueprint pass only: return JSON matching the requested schema. Do not generate final shots or long prose.`;

  const seriesSummary = _compactLLMText(
    storyline.comprehensive_summary || storyline.plot_summary || '',
    3500
  );
  const globalContextBlock = seriesSummary
    ? `\n═══ GLOBAL SERIES CONTEXT ═══\n${seriesSummary}\n`
    : '';
  const fullStorySimulation = storyline.full_story_simulation
    ? (typeof storyline.full_story_simulation === 'string'
      ? safeJsonParse(storyline.full_story_simulation, {})
      : storyline.full_story_simulation)
    : null;

  const selectCurrentEpisodeTrajectory = (value) => {
    if (Array.isArray(value)) {
      return value.find(ep =>
        Number(ep?.season) === Number(seasonNumber) &&
        Number(ep?.episode) === Number(episodeNumber)
      ) || null;
    }
    if (value && typeof value === 'object') {
      const epSeason = Number(value?.season ?? value?.episode?.season);
      const epNumber = Number(value?.episode ?? value?.episode?.episode);
      if (epSeason === Number(seasonNumber) && epNumber === Number(episodeNumber)) return value;
    }
    return null;
  };

  const currentEpisodeTrajectoryRaw =
    selectCurrentEpisodeTrajectory(narrativeSimulation?.episode_trajectory) ||
    selectCurrentEpisodeTrajectory(narrativeSimulation?.trajectory) ||
    selectCurrentEpisodeTrajectory(fullStorySimulation?.episode_trajectory) ||
    null;
  const currentEpisodeTrajectory = _compactEpisodeTrajectoryForLLM(currentEpisodeTrajectoryRaw);

  const scriptFullStorySimulation = fullStorySimulation
    ? {
        opening_state: _compactLLMText(fullStorySimulation.opening_state || '', 700),
        inciting_event: _compactLLMText(fullStorySimulation.inciting_event || '', 900),
        finale_resolution: _compactLLMText(fullStorySimulation.finale_resolution || '', 900),
        season_endpoints: Array.isArray(fullStorySimulation.season_endpoints)
          ? fullStorySimulation.season_endpoints.slice(0, 8)
          : [],
        unresolved_threads: Array.isArray(fullStorySimulation.unresolved_threads)
          ? fullStorySimulation.unresolved_threads.slice(-8)
          : [],
        episode_trajectory: currentEpisodeTrajectory ? [currentEpisodeTrajectory] : [],
      }
    : null;

  const compactSeriesContext = _buildCompactEpisodeContext({
    storyline,
    fullStorySimulation: scriptFullStorySimulation,
    seasonNumber,
    episodeNumber,
    episodeTrajectory: currentEpisodeTrajectory,
    recentEpisodes,
  });

  const scriptNarrativeSimulation = narrativeSimulation
    ? {
        episode: narrativeSimulation.episode
          ? {
              season: Number(narrativeSimulation.episode.season ?? seasonNumber),
              episode: Number(narrativeSimulation.episode.episode ?? episodeNumber),
            }
          : { season: Number(seasonNumber), episode: Number(episodeNumber) },
        opening_state: _compactLLMText(narrativeSimulation.opening_state || '', 700),
        ending_state: _compactLLMText(narrativeSimulation.ending_state || '', 700),
        scene_beat_plan: _compactSceneBeatPlan(narrativeSimulation.scene_beat_plan),
        continuity_invariants: Array.isArray(narrativeSimulation.continuity_invariants)
          ? narrativeSimulation.continuity_invariants.slice(0, 8).map(x => _compactLLMText(x, 250))
          : [],
        unresolved_threads: Array.isArray(narrativeSimulation.unresolved_threads)
          ? narrativeSimulation.unresolved_threads.slice(-6).map(x => _compactLLMText(x, 250))
          : [],
        episode_trajectory: currentEpisodeTrajectory || null,
      }
    : null;

  console.log(`[ScriptWriter] LLM script context locked to S${seasonNumber}E${episodeNumber} trajectory only`);

  const fullStoryBlock = `\n═══ COMPACT AUTHORITATIVE SERIES CONTEXT ═══\n${JSON.stringify(compactSeriesContext)}\nThe complete master plan remains durable in DB; this request receives only bounded current-episode continuity.\n`;

  const continuityBlock = recentEpisodes.length
    ? _compactLLMText(
        `\n═══ STORY CONTINUITY (from last ${recentEpisodes.length} posted episodes) ═══\n` +
        recentEpisodes.slice(-3).map(e => {
          const sc = safeJsonParse(e.script, {});
          return `Ep ${e.episode_number}: ${_compactLLMText(sc.updated_plot_summary || '(no summary)', 500)}\n  Director's note: ${_compactLLMText(sc.director_vision || '', 300)}`;
        }).join('\n'),
        2600
      )
    : '';

  const characterBlock = (characters || []).map(c => {
    const vp = typeof c.visual_profile === 'string'
      ? safeJsonParse(c.visual_profile, {})
      : (c.visual_profile || {});
    return _compactLLMText(`▸ ${c.name} (${c.role || 'character'}) [gender: ${c.gender || vp.gender || 'unknown'}, voice_id: ${c.voice_id || 'unassigned'}, seed: ${c.seed || 'unassigned'}]
  Psychology: ${c.description || ''}
  Performance note: ${vp.performance_note || c.description || ''}
  Identity tag-lock: ${c.visual_anchor || c.description || ''}`, 1400);
  }).join('\n\n');

  const visualLanguage = storyline.visual_language
    ? (typeof storyline.visual_language === 'string'
        ? safeJsonParse(storyline.visual_language, {})
        : storyline.visual_language)
    : null;

  const visualBlock = visualLanguage
    ? _compactLLMText(`\n═══ SERIES VISUAL LANGUAGE ═══
Palette: ${visualLanguage.primary_palette || ''}
Camera: ${visualLanguage.camera_philosophy || ''}
Motifs: ${(visualLanguage.recurring_motifs || []).join(', ')}`, 1200)
    : '';

  const seasonArc = (() => {
    const arcs = storyline.season_arcs
      ? (typeof storyline.season_arcs === 'string'
          ? safeJsonParse(storyline.season_arcs)
          : storyline.season_arcs)
      : [];
    return _compactLLMText(arcs[seasonNumber - 1] || 'Continue the story with escalating stakes', 1400);
  })();

  const episodeType = isSeriesMovie
    ? `THE SERIES FINALE MOVIE — this is the culmination of ALL 4 seasons, ALL character arcs, ALL thematic threads. Runtime: ~${targetMinutes} minutes.`
    : isFinale
      ? `SEASON ${seasonNumber} FINALE — a cliffhanger that recontextualises everything. Runtime: ~${targetMinutes} minutes.`
      : `Season ${seasonNumber}, Episode ${episodeNumber} — a chapter in the season arc. Runtime: ~${targetMinutes} minutes.`;

  // The exact count already agreed by the scene-simulation stage is authoritative
  // once it exists (simulateEpisodeStory produces exactly that many scenes); a
  // fuzzy hardcoded range here ('20-25' regardless of actual target length) could
  // tell the writer a different number than the pipeline's own completeness check
  // expects (config.computeExpectedSceneCount, which now scales with runtime) --
  // for any film longer than the old fixed default, that mismatch meant the
  // writer was never asked for enough scenes to cover its own ending.
  const sceneCount = Array.isArray(narrativeSimulation?.scene_beat_plan) && narrativeSimulation.scene_beat_plan.length
    ? String(narrativeSimulation.scene_beat_plan.length)
    : String(config.computeExpectedSceneCount({ isSeriesMovie, targetMinutes }));

  let blueprint = null;
  const hasReusableBlueprint =
    !runtimeRetryNote &&
    _hasPersistedProductionBlueprint(existingScript);

  if (hasReusableBlueprint) {
    blueprint = {
      ...existingScript,
      // Preserve the locked simulation when resuming an incomplete draft.
      episode_trajectory: existingScript.episode_trajectory || currentEpisodeTrajectory,
      narrative_simulation: existingScript.narrative_simulation || narrativeSimulation || null,
    };
    console.log(`[ScriptWriter] ↺ Reusing persisted blueprint for S${seasonNumber}E${episodeNumber}; generating only missing scene work`);
  } else {
    const blueprintUserPrompt = `${runtimeRetryNote ? `⚠️ RETRY REQUIRED — PREVIOUS SCRIPT WAS REJECTED:\n${runtimeRetryNote}\n\n` : ''}Direct: ${episodeType}

${globalContextBlock}
${fullStoryBlock}
═══ SERIES: "${storyline.title}" (${storyline.genre}) ═══
Central Theme: ${storyline.central_theme || storyline.plot_summary}
Tone: ${storyline.tone_manifesto || ''}
Season ${seasonNumber} Arc: ${seasonArc}
${visualBlock}
${continuityBlock}
${scriptNarrativeSimulation ? `═══ PRE-GENERATION EPISODE SIMULATION — LOCKED ═══\n${JSON.stringify(scriptNarrativeSimulation)}\nDo not change the causal order, opening/closing states, character changes, climax, or next hook.\n` : ""}

═══ CAST (locked — voice_id and seed are permanent) ═══
${characterBlock}

Return this JSON structure. Do NOT include a "shots" array inside any scene.
{
  "episode_title": "Title that is a metaphor or line of dialogue, not a plot summary",
  "season_number": ${seasonNumber},
  "episode_number": ${episodeNumber},
  "director_vision": "1 paragraph",
  "episode_color_palette": "Dominant colours and meaning",
  "episode_motif": "Recurring visual or symbolic element",
  "emotional_arc": {
    "opening_state": "Opening emotional state",
    "escalation": "Pressure that builds",
    "break_point": "Moment something cracks",
    "closing_state": "Changed/refused state"
  },
  "updated_plot_summary": "2-3 sentences updating the living series bible",
  "music_direction": "Composer reference",
  "caption": "Social caption ending with an existential question. 6-10 hashtags on a separate line.",
  "episode_transition": "FFMPEG transition effect",
  "episode_final_color_grade": "FFMPEG color grade",
  "is_series_finale": ${isSeriesMovie ? 'true' : 'false'},
  "safety_check_passed": true,
  "safety_notes": "",
  "scenes": [
    {
      "scene_number": 1,
      "scene_description": "What is actually happening — including what is UNSAID",
      "emotional_beat": "Specific emotional shift",
      "location": "INT./EXT. specific location — time of day",
      "lighting_design": "Quality, direction, and colour",
      "camera_language": "How the camera is operated",
      "characters_present": ["character names"],
      "shot_count_target": 3
    }
  ]
}

Write ${sceneCount} scenes. Each scene needs 2-5 shots according to narrative need.
The compiled episode MUST run at minimum 2 minutes. The final scene's last shot is the cliffhanger.`;

    blueprint = await callLLM(systemPrompt, blueprintUserPrompt, undefined, { useStream: false });
    if (!Array.isArray(blueprint.scenes) || blueprint.scenes.length === 0) {
      throw new Error('[ScriptWriter] Blueprint pass returned no scenes');
    }
  }

  blueprint.episode_trajectory = blueprint.episode_trajectory || currentEpisodeTrajectory;
  blueprint.narrative_simulation = blueprint.narrative_simulation || narrativeSimulation || null;
  blueprint.scene_simulation = blueprint.scene_simulation || narrativeSimulation || null;

  // NEVER regress a durable checkpoint on resume. If a prior run already
  // completed shot simulation or scene-shot writing, reusing the blueprint
  // must not overwrite those later artifacts with an early "blueprint" stage.
  if (typeof checkpoint === 'function' && !hasReusableBlueprint) {
    await checkpoint({
      stage: 'blueprint',
      sceneNumber: null,
      script: {
        ...blueprint,
        checkpoint_state: {
          stage: 'blueprint',
          completed_scene_numbers: [],
          shot_simulation_completed_scene_numbers: [],
        },
      },
    });
  } else if (hasReusableBlueprint) {
    blueprint.shot_simulation = blueprint.shot_simulation || existingScript?.shot_simulation || null;
    blueprint.checkpoint_state = existingScript?.checkpoint_state || blueprint.checkpoint_state || null;
    console.log(
      `[ScriptWriter] ↺ Preserved durable checkpoint stage=${blueprint.checkpoint_state?.stage || 'unknown'} ` +
      `while resuming existing blueprint for S${seasonNumber}E${episodeNumber}`
    );
  }

  const shotSimulation = await simulateEpisodeShots({
    storyline,
    characters,
    episodeSimulation: scriptNarrativeSimulation || narrativeSimulation,
    sceneSimulation: scriptNarrativeSimulation || narrativeSimulation,
    scenes: blueprint.scenes,
    episodeNumber,
    seasonNumber,
    targetMinutes,
    existingShotSimulation: blueprint?.shot_simulation || existingScript?.shot_simulation || null,
    checkpoint: async ({ stage, sceneNumber, completedScenes, shotSimulation: sim }) => {
      if (typeof checkpoint !== 'function') return;
      await checkpoint({
        stage,
        sceneNumber,
        script: {
          ...blueprint,
          scene_simulation: blueprint.scene_simulation,
          shot_simulation: sim,
          checkpoint_state: {
            stage,
            completed_scene_numbers: Array.isArray(blueprint.scenes)
              ? blueprint.scenes.map(s => Number(s.scene_number)).filter(Boolean)
              : [],
            shot_simulation_completed_scene_numbers: completedScenes,
          },
        },
      });
    },
  });

  blueprint.shot_simulation = shotSimulation;

  if (typeof checkpoint === 'function') {
    await checkpoint({
      stage: 'shot_simulation_complete',
      sceneNumber: null,
      script: blueprint,
    });
  }

  const existingScenes = Array.isArray(existingScript?.scenes)
    ? existingScript.scenes
    : [];

  const scenesWithShots = await _writeSceneShotsSequential({
    scenes: blueprint.scenes,
    characterBlock,
    characters,
    shotSimulation,
    existingScenes,
    checkpoint: async ({ sceneNumber, completedSceneNumbers, scenes: partialScenes }) => {
      if (typeof checkpoint !== 'function') return;
      await checkpoint({
        stage: 'scene_shot_writing',
        sceneNumber,
        script: {
          ...blueprint,
          scenes: partialScenes,
          shot_simulation: shotSimulation,
          checkpoint_state: {
            stage: 'scene_shot_writing',
            completed_scene_numbers: completedSceneNumbers,
            shot_simulation_completed_scene_numbers:
              Array.from(new Set((shotSimulation.shots || []).map(s => Number(s.scene_number)))),
          },
        },
      });
    },
  });

  const completedScriptWithSpeech = await ensureSceneSpeechCoverage(
    { ...blueprint, scenes: scenesWithShots },
    { storyline, characters }
  );

  const directorialScript = directorialOrchestrator.applyToScript(
    completedScriptWithSpeech,
    { seasonNumber, episodeNumber }
  );

  const completedScript = {
    ...directorialScript,
    episode_trajectory: currentEpisodeTrajectory || completedScriptWithSpeech.episode_trajectory,
    narrative_simulation: narrativeSimulation || completedScriptWithSpeech.narrative_simulation,
    scene_simulation: narrativeSimulation || completedScriptWithSpeech.scene_simulation,
    shot_simulation: shotSimulation,
    global_continuity_state: globalContinuity.buildGlobalContinuityState(directorialScript),
    checkpoint_state: {
      stage: 'script_complete',
      completed_scene_numbers: scenesWithShots.map(s => Number(s.scene_number)),
      shot_simulation_completed_scene_numbers:
        Array.from(new Set((shotSimulation.shots || []).map(s => Number(s.scene_number)))),
    },
  };

  if (typeof checkpoint === 'function') {
    await checkpoint({
      stage: 'script_complete',
      sceneNumber: null,
      script: completedScript,
    });
  }

  console.log(`[ScriptWriter] Episode assembled — ${completedScript.scenes.length} scenes, ` +
    `${completedScript.scenes.reduce((n, s) => n + (s.shots || []).length, 0)} shots, persistent checkpoints enabled.`);

  return completedScript;
}


// ─────────────────────────────────────────────────────────────────────────────
// Sequential per-scene shot generation with rolling story memory
//
// "Memory" here is a short, locally-built digest of what has already been
// written (last location, emotional beat, and closing line per scene) plus
// the blueprint's own description of what the CURRENT scene needs to
// accomplish. Nothing here costs an extra LLM call — the summary is derived
// from data already returned by the previous scene's shot generation.
// ─────────────────────────────────────────────────────────────────────────────

const LTX_SHOT_WRITING_RULES = `
═══ LTX SHOT DESCRIPTION — REQUIRED OUTPUT STYLE ═══

The field ltx_shot_description is the actual prompt sent to the LTX image-to-video model.
It is NOT a production-control specification, shot contract, metadata block, or checklist.
Write it as natural cinematic language whose length matches the complexity of the shot. There is NO
hard word or sentence cap. A simple shot can be concise; dialogue-heavy or multi-beat shots may be
longer when every sentence adds concrete visual or audio information. Start directly with what is
visibly happening and describe the shot chronologically from the supplied first frame: what changes
first, what happens next, and where the shot ends.
Use literal, concrete cinematography language. Describe only things the model can see or hear:
visible subject movement, gaze, gestures, expressions, object movement, environment, lighting,
and requested camera movement. Keep established visual details brief because the supplied image is
the exact first frame; focus on the changes that occur during the clip. When multiple characters
are visible, preserve their relative screen positions naturally in the prose, for example by saying
that one character remains in the foreground while another stays behind them.

Do NOT write headings, labels, field names, JSON-like language, numbered instructions, control phrases,
spatial-map declarations, warnings, negative-prompt lists, or explanations to the model. Never write
phrases such as "LTX SHOT CONTRACT", "LOCKED SPATIAL MAP", "Audio/text boundary", "preserve the map",
"do not speak the prompt", or similar production-control language. Do not describe the prompt itself.
Do not narrate character names or staging as if they are instructions. Natural phrases such as
"the woman at center" or "the man behind her" are acceptable when needed for clarity.

For image-to-video continuity, describe only the motion and change from the supplied first frame rather
than re-describing the entire still. Keep the screen geography stable through natural visual wording.
Camera movement is included only when requested. If there is dialogue, place the spoken words naturally
in the paragraph; otherwise do not invent speech. Never turn actions, emotions, camera directions, or
staging into quoted dialogue. End on a clear visible state that can naturally lead into the next shot.`;

const CRITICAL_RULES_RECAP = `
═══ BEFORE YOU RESPOND — RE-CHECK THESE FIVE THINGS ═══
This is a condensed recap of the highest-stakes rules above, not new information —
re-verify your draft against it before returning JSON:
1. Output is ONLY a JSON object with exactly two top-level keys, "scene_continuity_bible"
   and "shots" — no prose, no markdown fences, nothing before or after the JSON.
2. scene_continuity_bible is set and every shot's staging stays consistent with it
   (axis_of_action, wardrobe_lock, active_props, lighting_lock) — including shots several
   cuts after a character or prop was last mentioned, not just the immediately adjacent one.
3. image_prompt is a frozen STILL only — no motion, no camera movement, no dialogue, no
   temporal words. All motion/action/dialogue belongs in ltx_shot_description instead.
4. end_frame_transition and next_shot_continuity are concrete and physically renderable —
   this shot's exact terminal frame becomes the next shot's opening keyframe. A vague or
   abstract handoff breaks the physical continuity bridge, not just the prose.
5. No silent changes: wardrobe, environment, and persistent props carry forward unchanged
   unless this exact shot explicitly authors the change.
`;

const SHOT_SYSTEM_PROMPT = `${DIRECTOR_PERSONA}
${IS_AGNES_PROVIDER ? AGNES_CONVERSATIONAL_RULES : ''}
${TRAVEL_CONTINUITY_RULES}
${CONTINUITY_BIBLE_RULES}
${MULTI_SPEAKER_LTX_RULES}
${PACING_RULES}
${FFMPEG_EFFECTS_CATALOG}
${LTX_SHOT_WRITING_RULES}
${CRITICAL_RULES_RECAP}
You are generating the shots for ONE scene of an episode, working scene-by-scene
through the full episode in order. Return ONLY a JSON object with exactly two top-level
keys — "scene_continuity_bible" and "shots" — nothing else.`;

const SHOT_SCHEMA = `{
  "scene_continuity_bible": {
    "axis_of_action": "Description of the locked 180-degree line for this scene's primary interaction, and which named character is locked to which screen side. Empty string if this scene has no multi-character interaction requiring a locked axis.",
    "line_cross_shots": [1],
    "line_cross_reason": "If line_cross_shots is non-empty, the visible in-frame motivation for each authored crossing (camera move shown, character shown walking across). Empty if line_cross_shots is empty.",
    "wardrobe_lock": [
      { "name": "Exact character name from CAST", "state": "Locked wardrobe/prop-on-person description that persists across the whole scene unless a shot explicitly changes it." }
    ],
    "active_props": [
      { "prop": "Prop name", "state": "Current position/state, persists across every shot of the scene until a shot explicitly changes it." }
    ],
    "lighting_lock": "Established light source, direction, color temperature and time-of-day evidence for the whole scene, unless the story explicitly moves time forward within it."
  },
  "shots": [
    {
      "shot_index": 1,
      "shot_type": "ECU|CU|MCU|MS|MWS|WS|XWS|OTS|POV|AERIAL|INSERT",
      "shot_purpose": "Why does this shot exist?",
      "shot_description": "What the camera sees — concise framing, depth and focus description.",
      "ltx_shot_description": "Natural-language LTX image-to-video prompt whose length matches shot complexity with NO hard word or sentence cap. Start directly with visible action and describe the chronological changes from the supplied first frame through the end state. Use literal cinematography language only; no headings, control labels, spatial-map declarations, prompt instructions, or negative-prompt lists.",
      "camera_movement": "static|slow push-in|pull back|pan left|pan right|handheld drift|tilt up|tilt down|crane up|none",
      "focal_length_hint": "wide 24mm|normal 35mm|portrait 50mm|telephoto 85mm|macro 100mm",
      "depth_layering": "Describe foreground, midground, background separation and focus plane for this shot",
      "characters_in_shot": ["character names — must match CAST"],
      "character_staging": [
        {
          "name": "Exact character name from CAST",
          "screen_position": "far-left|screen-left|left-of-center|screen-center|right-of-center|screen-right|far-right",
          "depth": "foreground|midground|background",
          "facing_toward": "Exact character name, object, or spatial direction",
          "action": "Specific visible action performed during the shot",
          "pose": "Specific frozen opening pose",
          "eyeline": "Exact gaze target",
          "interaction": "Concrete physical/social relationship to another visible character or prop",
          "speaking": true,
          "visual_identity": "Short identity cue that distinguishes this character from other visible characters"
        }
      ],
      "character_positions": "Human-readable spatial summary generated from character_staging; mention every visible character, screen position, depth, and relationship.",
      "speakers_in_shot": ["Character names speaking in chronological order; empty array for silent/action-only shots"],
      "start_frame_state": "Exact opening visual state of this shot: character identity, screen position, body/hand/prop state, gaze, expression, environment, lighting and camera framing. For a continuation, this must match the previous shot end state before new motion begins. Plain descriptive prose only and no quotation marks.",
      "end_frame_state": "Exact terminal visual state of this shot at its final frame: character identity, screen position, body/hand/prop state, gaze, expression, environment, lighting and camera framing. Plain descriptive prose only and no quotation marks.",
      "emotional_subtext": "What is the character hiding or feeling beneath the surface, described plainly and never as quoted dialogue",
      "environmental_story_beat": "Specific way the environment participates in the story during this shot: light, weather, objects, architecture, distant activity, time-of-day evidence, or environmental change tied to this episode",
      "temporal_arc": "Describe the visual progression inside the shot from beginning state to development/change to meaningful end state",
      "end_frame_transition": "Describe the exact final visual/audio state of this shot and the contextual handoff into the next shot. Use an in-world descriptive phrase such as a held eyeline, continuing object movement, environmental reveal, sound bridge, lighting change, spatial discovery, time shift, or purposeful hard cut. Do NOT write editing instructions or use quotation marks. TRANSITION CONTRACT: this shot's exact terminal frame is physically rendered as the FIRST keyframe of the next shot's clip and the next shot's opening still is rendered as its LAST keyframe (Agnes keyframe mode and the LTX-2.3 First-Last-Frame provider both bridge between them over roughly 3-4 seconds before the next shot's own action begins) — write a handoff a video model can actually resolve in that window, never an abstract or purely editorial cut. Treat this handoff as equally important as the shot's own content, not an afterthought.",
      "next_shot_continuity": "State the concrete fact the following shot should inherit from this shot’s ending: gaze, prop position, body position, environment, sound source, light state, location reveal, or unresolved action. Plain descriptive prose only. This is the physical continuity anchor the next shot's video generation is conditioned on — get it as concrete and inheritable as the shot's own staging.",
      "motion_phase_at_cut": "For a shot that ends mid-motion, the exact kinetic phase at the terminal frame (how far into the gesture, and in which direction) so the next shot continues that precise motion instead of restarting it. Empty when the shot ends on a settled, motionless state. See SCENE CONTINUITY BIBLE match-on-action rule.",
      "location_transition": "none | departure | transit | arrival",
      "travel_stage": "none | prepare | depart | in_transit | approach | arrive",
      "origin_location": "Current physical origin at the start of this shot",
      "destination_location": "Intended destination if this shot belongs to a travel sequence; otherwise empty",
      "travel_mode": "walk | drive | ride | train | bus | bike | boat | aircraft | stairs | elevator | none",
      "route_beat": "Concrete visible movement that changes physical position during this shot, or empty if stationary.",
      "scene_environment": "The most narratively important environmental context visible in this shot",
      "pose_state": "standing|sitting|walking|running|leaning|crouching|lying|turning|reaching|fighting",
      "image_prompt": "STILL-FRAME prompt for the Cloudflare FLUX.2 image model. Describe ONE settled opening frame only: exact visible characters, immutable identity cues supplied by references, screen position, depth, frozen pose, facing, eyeline, static hand/prop contact, framing, fixed viewpoint, lighting, palette, environment and atmosphere. The staging action field must describe a frozen physical state, never a movement. NEVER write speaking, talking, lips moving, dialogue delivery, camera movement, animation, audio, temporal progression, travel instructions, motion verbs or end-frame transitions. 9:16 vertical photorealistic cinematic frame. Character identity comes from supplied reference images; do not invent alternate physical descriptions.",
      "duration": ${_SCRIPT_MAX_DURATION},
      "clip_duration": ${_SCRIPT_MAX_DURATION},
      "shot_pacing_type": "hook|action|reaction|broll_cutaway|dialogue_mid|dialogue_full|slow_dramatic|establishing",
      "narrative_complexity": "low|medium|high",
      "motion_level": "low|medium|high",
      "motion_intensity": "0.0 to 1.0 numeric — how much camera motion energy this shot has (0=static, 1=maximal)",
      "subject_motion": "still|subtle|active|intense",
      "ambient_motion": "still|gentle|dynamic",
      "music_cue": "none|subtle|prominent",
      "music_reason": "Why music is genuinely needed in this shot, or empty when music_cue is none.",
      "tts_mode": "spoken|internal_monologue|ambient|phone_vo",
      "dialogue_or_action": "EXACT FORMAT RULE: only spoken dialogue uses quotation marks. Spoken dialogue: CHARACTER NAME: \"exact words spoken aloud\" followed by optional unquoted delivery/emotion notes. Action-only: plain unquoted description such as Dr. Jane looks at her phone, her expression tightening. NEVER quote actions, emotions, stage directions, camera movement, posture, facial expressions, or subtext. Internal monologue: NAME (V.O.): exact audible thought without quotation marks. Phone voiceover: REMOTE CALLER (PHONE): \"exact audible words\". If the shot is silent/action-only, there must be ZERO quotation marks."
    }
  ]
}`;

/**
 * Build a one-line memory digest for a scene that has already been written.
 * Purely local — no LLM call — derived from the shots already returned.
 */

/**
 * HARD SPEAKER / DIALOGUE CONTRACT
 *
 * Audible dialogue and speaker identity are one semantic unit. A shot is never
 * considered production/LTX-ready when it contains audible speech without a
 * deterministic named speaker.
 */
function _canonicalCharacterName(value, characters = []) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const normalize = candidate =>
    String(candidate || '').trim().toLowerCase().replace(/\s+/g, ' ');

  const catalog = Array.isArray(characters) ? characters : [];
  const exact = catalog.find(c => normalize(c?.name) === normalize(raw));
  if (exact?.name) return String(exact.name).trim();

  const partial = catalog.find(c => {
    const a = normalize(c?.name);
    const b = normalize(raw);
    return a && b && (a.includes(b) || b.includes(a));
  });
  if (partial?.name) return String(partial.name).trim();

  // When a cast catalog is supplied, an unknown speaker is invalid.
  // When no catalog is available (runtime repair fallback), preserve the
  // explicit metadata so the caller can still validate the structure.
  return catalog.length ? null : raw;
}

function _extractQuotedSpeakerLabels(text, { unique = true } = {}) {
  const source = String(text || '');
  const occurrences = [];
  // Capture EVERY speaker-label occurrence immediately before an opening quote.
  // This intentionally does NOT deduplicate turns: A: "one" A: "two" is two
  // speaker-labelled turns even though the speaker roster contains one person.
  const re = /(?:^|[\n\r]|\s)([^:\n\r]{1,100}):\s*[\"“]/g;
  let match;
  while ((match = re.exec(source))) {
    const name = String(match[1] || '').trim();
    if (name) occurrences.push(name);
  }

  if (!unique) return occurrences;

  const labels = [];
  for (const name of occurrences) {
    if (!labels.some(existing => existing.toLowerCase() === name.toLowerCase())) {
      labels.push(name);
    }
  }
  return labels;
}

function _extractQuotedUtterances(text) {
  return String(text || '').match(/["“”]\s*[^"“”]{1,}\s*["“”]/g) || [];
}

function _speakerTurnArrayTemplate(shot) {
  return JSON.stringify(
    _extractQuotedUtterances(shot?.dialogue_or_action)
      .map((_, index) => `<FULL CAST name for utterance ${index + 1}>`)
  );
}

function _buildTurnOwnershipRepairInstruction(shot) {
  const utterances = _extractQuotedUtterances(shot?.dialogue_or_action);
  const numberedUtterances = utterances
    .map((utterance, index) => `${index + 1}. ${JSON.stringify(utterance)}`)
    .join('\n');

  return [
    `EXACT TURN OWNERSHIP TASK: This shot contains ${utterances.length} quoted utterances.`,
    `Assign exactly one canonical character name from FULL CAST to each utterance below, in chronological order.`,
    `Return exactly ${utterances.length} entries in speakers_in_shot. Repeated names are required when a character speaks more than once; do not deduplicate or return only a speaker roster.`,
    `Do not infer a simple alternating pattern unless the shot's dialogue context supports it. Preserve the dialogue text and order.`,
    `Required array shape (replace each placeholder with the exact speaker name): ${_speakerTurnArrayTemplate(shot)}`,
    `NUMBERED UTTERANCES:\n${numberedUtterances}`,
  ].join('\n');
}

function _shotVisibleCharacters(shot, scene, characters) {
  // characters_in_shot is the actual frame-level authority. Only fall back to
  // scene.characters_present when the shot did not provide a frame-level list.
  const shotNames = Array.isArray(shot?.characters_in_shot)
    ? shot.characters_in_shot.filter(Boolean)
    : [];
  const raw = shotNames.length
    ? shotNames
    : (Array.isArray(scene?.characters_present) ? scene.characters_present : []);

  const names = raw
    .map(value => _canonicalCharacterName(value, characters))
    .filter(Boolean);

  return [...new Map(
    names.map(name => [String(name).trim().toLowerCase(), String(name).trim()])
  ).values()];
}

function _inferShotSpeakers(shot, scene, characters) {
  const explicit = [
    shot?.speaker_name,
    shot?.speaker,
    ...(Array.isArray(shot?.speakers_in_shot) ? shot.speakers_in_shot : []),
  ]
    .filter(Boolean)
    .map(value => _canonicalCharacterName(value, characters))
    .filter(Boolean);

  const labelled = _extractQuotedSpeakerLabels(shot?.dialogue_or_action)
    .map(value => _canonicalCharacterName(value, characters))
    .filter(Boolean);

  const stagingSpeakers = (Array.isArray(shot?.character_staging) ? shot.character_staging : [])
    .filter(row => row && row.speaking === true)
    .map(row => _canonicalCharacterName(row.name, characters))
    .filter(Boolean);

  const visible = _shotVisibleCharacters(shot, scene, characters);
  const ordered = [];

  for (const candidate of [...explicit, ...labelled, ...stagingSpeakers]) {
    const canonical = _canonicalCharacterName(candidate, characters);
    const key = String(canonical || '').trim().toLowerCase();
    if (key && !ordered.some(existing => existing.toLowerCase() === key)) {
      ordered.push(String(canonical).trim());
    }
  }

  // Deterministic fallback is safe only when exactly one visible/declared
  // character exists. Never guess between multiple characters.
  if (!ordered.length && visible.length === 1) {
    ordered.push(visible[0]);
  }

  if (!ordered.length && visible.length > 1) {
    const contextText = String(shot?.dialogue_purpose || '').toLowerCase();
    const mentioned = visible.filter(name =>
      contextText.includes(String(name).toLowerCase())
    );
    if (mentioned.length === 1) ordered.push(mentioned[0]);
  }

  if (!ordered.length) {
    const declared = (Array.isArray(scene?.characters_present) ? scene.characters_present : [])
      .map(value => _canonicalCharacterName(value, characters))
      .filter(Boolean);
    const uniqueDeclared = [...new Map(
      declared.map(name => [String(name).trim().toLowerCase(), String(name).trim()])
    ).values()];
    if (uniqueDeclared.length === 1) ordered.push(uniqueDeclared[0]);
  }

  return ordered;
}

function _getAuthoritativeConversationTurnSpeakers(shot, characters = []) {
  const turns = Array.isArray(shot?._conversation_plan?.turns)
    ? shot._conversation_plan.turns
    : [];
  const names = turns
    .map(turn => _canonicalCharacterName(turn?.speaker, characters))
    .filter(Boolean);
  return names;
}

function _enforceShotSpeechMetadata(shot, scene, characters = [], { hardFail = true } = {}) {
  const out = { ...(shot || {}) };
  const mode = String(out.tts_mode || '').trim().toLowerCase();
  const text = String(out.dialogue_or_action || '').trim();
  const audible = ['spoken', 'phone_vo', 'internal_monologue'].includes(mode);

  if (!audible) return { valid: true, shot: out, speakers: [], reason: '' };

  if ((mode === 'spoken' || mode === 'phone_vo') &&
      !/[\"“”]\s*[^\"“”]{1,}\s*[\"“”]/.test(text)) {
    const reason = `tts_mode=${mode} but dialogue_or_action contains no quoted audible words`;
    if (hardFail) throw new Error(`[ScriptWriter] SPEECH_CONTRACT_FAILED: ${reason}`);
    return { valid: false, shot: out, speakers: [], reason, code: 'SPEECH_CONTRACT_FAILED' };
  }

  const speakers = _inferShotSpeakers(out, scene, characters);

  if (!speakers.length) {
    const reason =
      `audible dialogue exists but no deterministic named speaker can be resolved; ` +
      `visible=${JSON.stringify(_shotVisibleCharacters(out, scene, characters))}`;
    if (hardFail) throw new Error(`[ScriptWriter] SPEECH_SPEAKER_REQUIRED: ${reason}`);
    return { valid: false, shot: out, speakers: [], reason, code: 'SPEECH_SPEAKER_REQUIRED' };
  }

  const labelledTurns = _extractQuotedSpeakerLabels(text, { unique: false })
    .map(value => _canonicalCharacterName(value, characters))
    .filter(Boolean);
  const labelled = [...new Map(
    labelledTurns.map(name => [String(name).trim().toLowerCase(), String(name).trim()])
  ).values()];

  const quotedUtterances =
    (mode === 'spoken' || mode === 'phone_vo')
      ? _extractQuotedUtterances(text)
      : [];
  const quotedCount = quotedUtterances.length;

  // Prefer the already-built conversation turn plan. It is the authoritative
  // chronological speaker registry and is more reliable than counting textual
  // NAME: prefixes in a persisted natural-language dialogue field.
  const plannedTurnSpeakers = _getAuthoritativeConversationTurnSpeakers(out, characters);

  let turnSpeakers = [];
  if ((mode === 'spoken' || mode === 'phone_vo') && quotedCount > 0) {
    if (plannedTurnSpeakers.length === quotedCount) {
      turnSpeakers = plannedTurnSpeakers.slice();
    } else if (Array.isArray(out.speakers_in_shot) && out.speakers_in_shot.length === quotedCount) {
      const canonicalRegistry = out.speakers_in_shot
        .map(name => _canonicalCharacterName(name, characters))
        .filter(Boolean);
      if (canonicalRegistry.length === quotedCount) turnSpeakers = canonicalRegistry;
    } else if (labelledTurns.length === quotedCount) {
      turnSpeakers = labelledTurns.slice();
    } else if (speakers.length === 1) {
      // One deterministic speaker may legitimately own several consecutive
      // quoted utterances. Repeat that speaker for each authored utterance.
      turnSpeakers = Array.from({ length: quotedCount }, () => speakers[0]);
    } else if (labelledTurns.length > 0) {
      // We have multiple known speakers but the natural-language field has an
      // incomplete label sequence. Do not manufacture an alternating pattern.
      // However, an ordered conversation plan may still establish ownership from
      // the per-turn metadata; if it did not, this shot is genuinely ambiguous.
      turnSpeakers = [];
    }

    if (!turnSpeakers.length) {
      const reason =
        `multi-turn spoken shot has ${quotedCount} quoted utterances but speaker ownership ` +
        `could not be deterministically established from the persisted turn plan, speaker registry, ` +
        `or explicit labels; known speakers=${JSON.stringify(speakers)}`;
      if (hardFail) throw new Error(`[ScriptWriter] SPEAKER_TURN_CONTRACT_FAILED: ${reason}`);
      return { valid: false, shot: out, speakers, reason, code: 'SPEAKER_TURN_CONTRACT_FAILED' };
    }
  }

  const speakerSequence = turnSpeakers.length
    ? turnSpeakers.slice()
    : (labelled.length ? labelled.slice() : speakers.slice());
  const finalSpeakers = [...new Map(
    speakerSequence.map(name => [String(name).trim().toLowerCase(), String(name).trim()])
  ).values()];

  out.speaker = speakerSequence[0];
  out.speaker_name = speakerSequence[0];
  out.speakers_in_shot = speakerSequence.slice();

  out.characters_in_shot = [...new Map(
    [
      ...(Array.isArray(out.characters_in_shot) ? out.characters_in_shot : []),
      ...speakerSequence,
    ]
      .map(value => _canonicalCharacterName(value, characters))
      .filter(Boolean)
      .map(name => [String(name).trim().toLowerCase(), String(name).trim()])
  ).values()];

  // If quoted speech has no explicit speaker prefix but the speaker is
  // unambiguous, insert the prefix deterministically.
  if ((mode === 'spoken' || mode === 'phone_vo') &&
      finalSpeakers.length === 1 &&
      labelled.length === 0) {
    out.dialogue_or_action = mode === 'spoken'
      ? `${finalSpeakers[0]}: ${text}`
      : `${finalSpeakers[0]} (PHONE): ${text}`;
  }

  // Make turn ownership explicit before downstream LTX authoring whenever
  // a deterministic chronological speaker registry is available. This is a
  // normalization step only; the quoted words themselves are never changed.
  if ((mode === 'spoken' || mode === 'phone_vo') &&
      quotedCount > 0 &&
      turnSpeakers.length === quotedCount) {
    const quotedParts = quotedUtterances;
    if (quotedParts.length === quotedCount) {
      const rebuilt = quotedParts.map((part, index) =>
        `${turnSpeakers[index]}: ${part}`
      ).join('\n');
      out.dialogue_or_action = rebuilt;
    }
  }

  if (Array.isArray(out.character_staging) && out.character_staging.length) {
    out.character_staging = out.character_staging.map(row => {
      if (!row || typeof row !== 'object') return row;
      const rowName = _canonicalCharacterName(row.name, characters);
      return {
        ...row,
        speaking: finalSpeakers.some(name =>
          String(name).trim().toLowerCase() === String(rowName || '').trim().toLowerCase()
        ),
      };
    });
  }

  return { valid: true, shot: out, speakers: finalSpeakers, reason: '' };
}

/**
 * Resolves a shot's speaker, attempting a bounded, targeted LLM repair when the
 * deterministic inference in _validateShotSimulationSpeech cannot resolve one
 * (e.g. an audible shot with 2+ visible characters where the model left
 * `speaker` empty). Mirrors the shot-ID repair pattern used earlier in
 * simulateEpisodeShots: small, scoped correction call, re-validate, bounded
 * retries -- rather than failing the entire scene simulation on the first
 * unresolved speaker, which is what the prompt's own SPEAKER CONTRACT text
 * ("must be repaired before it can be checkpointed") already promised but the
 * code never implemented.
 *
 * @throws {Error} SHOT_SIMULATION_SPEAKER_REQUIRED if still unresolved after
 *   `maxAttempts` repair attempts.
 */
async function _resolveShotSpeakerWithRepair(shot, targetScene, characters, { sceneNo, shotIndex, callLLM, maxAttempts = 3 }) {
  let validated = _validateShotSimulationSpeech(shot, targetScene, characters);
  let attempt = 0;
  while (!validated.valid && attempt < maxAttempts) {
    attempt += 1;
    console.warn(
      `[ScriptWriter] Shot speaker unresolved S${sceneNo}/${shotIndex}: ${validated.reason} speakerRepairAttempt=${attempt}`
    );
    const castNames = (Array.isArray(characters) ? characters : []).map(c => c?.name).filter(Boolean);
    const visible = _shotVisibleCharacters(shot, targetScene, characters);
    let repaired;
    try {
      repaired = await callLLM(
        `${DIRECTOR_PERSONA}\nYou are repairing ONLY the missing speaker for one already-authored shot. Return JSON only.`,
        `SCENE: S${sceneNo}, SHOT: ${shotIndex}\n` +
        `FULL CAST: ${JSON.stringify(castNames)}\n` +
        `CHARACTERS VISIBLE IN THIS SHOT: ${JSON.stringify(visible)}\n` +
        `dialogue_intent: ${shot?.dialogue_intent || ''}\n` +
        `dialogue_purpose: ${shot?.dialogue_purpose || ''}\n` +
        `action_arc: ${shot?.action_arc || ''}\n\n` +
        `This shot has audible dialogue (dialogue_intent requires a speaker) but no speaker could be ` +
        `determined. Decide which ONE character visible in this shot is speaking, based on the dialogue ` +
        `purpose and action described above. The name MUST be an exact match from FULL CAST.\n\n` +
        `Return ONLY {"speaker_name": "Exact Character Name From CAST"}.`,
        undefined,
        { useStream: false, temperature: 0.1 }
      );
    } catch (err) {
      console.warn(`[ScriptWriter] Speaker repair call failed S${sceneNo}/${shotIndex}: ${err.message}`);
      break;
    }
    const candidateName = _canonicalCharacterName(repaired?.speaker_name, characters);
    if (candidateName) {
      shot.speaker = candidateName;
      shot.speaker_name = candidateName;
    }
    validated = _validateShotSimulationSpeech(shot, targetScene, characters);
  }

  if (!validated.valid) {
    throw new Error(
      `[ScriptWriter] SHOT_SIMULATION_SPEAKER_REQUIRED S${sceneNo}/${shotIndex}: ${validated.reason} ` +
      `(unresolved after ${maxAttempts} repair attempts)`
    );
  }
  return validated.shot;
}

/**
 * Same principle as _resolveShotSpeakerWithRepair, generalized to
 * _enforceShotSpeechMetadata's three possible failure reasons: a missing
 * speaker name, a missing quoted dialogue line despite an audible tts_mode, or
 * ambiguous multi-turn speaker-to-quote ownership. One shared repair prompt
 * covers all three -- the model is shown the exact failure reason and asked to
 * return whichever of {speaker_name, speakers_in_shot, dialogue_or_action}
 * fixes it; only non-empty returned fields are merged in, then the shot is
 * re-validated with the same real check before being accepted.
 *
 * Every _enforceShotSpeechMetadata(..., {hardFail: true}) call site in this
 * file processes shots one at a time inside a loop (a scene's shots, or the
 * whole episode's shots via .map()), so a single unresolved shot anywhere
 * previously crashed the ENTIRE episode's script generation with zero
 * recovery attempt -- exactly the reported SHOT_SIMULATION_SPEAKER_REQUIRED
 * crash, just at later pipeline stages that also happen to affect more shots
 * per failure. This is the same fix, generalized to every site with that
 * pattern.
 *
 * @throws {Error} the original _enforceShotSpeechMetadata error message if
 *   still unresolved after `maxAttempts` repair attempts (parity with the
 *   hardFail:true behaviour this replaces -- a genuinely unresolvable shot
 *   still stops the run, it just gets real attempts to resolve first).
 */
async function _resolveShotSpeechWithRepair(shot, scene, characters, { sceneNo, shotIndex, callLLM: llm = callLLM, maxAttempts = 3 } = {}) {
  let result = _enforceShotSpeechMetadata(shot, scene, characters, { hardFail: false });
  let attempt = 0;
  while (!result.valid && attempt < maxAttempts) {
    attempt += 1;
    const label = `S${sceneNo ?? scene?.scene_number ?? '?'}/${shotIndex ?? '?'}`;
    console.warn(`[ScriptWriter] Shot speech metadata invalid ${label}: ${result.reason} speechRepairAttempt=${attempt}`);
    const castNames = (Array.isArray(characters) ? characters : []).map(c => c?.name).filter(Boolean);
    const current = result.shot;
    const turnOwnershipInstruction = result.code === 'SPEAKER_TURN_CONTRACT_FAILED'
      ? `\n\n${_buildTurnOwnershipRepairInstruction(current)}\nReturn ONLY {"speakers_in_shot":${_speakerTurnArrayTemplate(current)}}. Do not return a single speaker_name as a substitute.`
      : '';
    let repaired;
    try {
      repaired = await llm(
        `${DIRECTOR_PERSONA}\nYou are repairing ONLY the speech metadata for one already-authored shot. Return JSON only.`,
        `SHOT ${label}\n` +
        `FULL CAST: ${JSON.stringify(castNames)}\n` +
        `tts_mode/dialogue_intent: ${current.tts_mode || current.dialogue_intent || ''}\n` +
        `current dialogue_or_action: ${current.dialogue_or_action || '(empty)'}\n` +
        `current speaker_name: ${current.speaker_name || '(empty)'}\n` +
        `current speakers_in_shot: ${JSON.stringify(current.speakers_in_shot || [])}\n\n` +
        `PROBLEM TO FIX: ${result.reason}${turnOwnershipInstruction}\n\n` +
        `Return ONLY the fields that need correcting to fix the stated problem, as JSON:\n` +
        `{"speaker_name": "Exact Character Name From CAST or omit if unchanged", ` +
        `"speakers_in_shot": ["ordered list, one per quoted utterance, or omit if unchanged"], ` +
        `"dialogue_or_action": "corrected NAME: \\"quoted line\\" text, or omit if unchanged"}`,
        undefined,
        { useStream: false, temperature: 0.1 }
      );
    } catch (err) {
      console.warn(`[ScriptWriter] Speech repair call failed ${label}: ${err.message}`);
      break;
    }
    const patched = { ...current };
    const patchedSpeaker = _canonicalCharacterName(repaired?.speaker_name, characters);
    if (patchedSpeaker) { patched.speaker = patchedSpeaker; patched.speaker_name = patchedSpeaker; }
    if (Array.isArray(repaired?.speakers_in_shot) && repaired.speakers_in_shot.length) {
      const canon = repaired.speakers_in_shot.map(n => _canonicalCharacterName(n, characters)).filter(Boolean);
      if (canon.length) patched.speakers_in_shot = canon;
    }
    if (typeof repaired?.dialogue_or_action === 'string' && repaired.dialogue_or_action.trim()) {
      patched.dialogue_or_action = repaired.dialogue_or_action.trim();
    }
    result = _enforceShotSpeechMetadata(patched, scene, characters, { hardFail: false });
  }

  if (!result.valid) {
    const prefix = result.code ? `${result.code}: ` : '';
    throw new Error(`[ScriptWriter] ${prefix}${result.reason} (unresolved after ${maxAttempts} repair attempts)`);
  }
  return result.shot;
}

function _validateShotSimulationSpeech(shot, scene, characters = []) {
  const mode = String(shot?.dialogue_intent || '').trim().toLowerCase();
  if (!['spoken', 'phone_vo', 'internal_monologue'].includes(mode)) {
    return { valid: true, shot: { ...(shot || {}) }, reason: '' };
  }

  const out = { ...(shot || {}) };
  const inferred = _inferShotSpeakers(
    {
      ...out,
      tts_mode: mode,
      dialogue_or_action: out.dialogue_purpose || '',
    },
    scene,
    characters
  );

  if (!inferred.length) {
    return {
      valid: false,
      shot: out,
      reason:
        `dialogue_intent=${mode} requires a named speaker; model returned an empty speaker ` +
        `and the speaker cannot be deterministically resolved from the locked scene/cast`,
    };
  }

  out.speaker = inferred[0];
  out.speaker_name = inferred[0];
  out.speakers_in_shot = inferred.slice();
  return { valid: true, shot: out, reason: '' };
}

function _summarizeSceneForMemory(scene) {
  const shots = scene.shots || [];
  const lastLine = [...shots].reverse().find(s => s.dialogue_or_action)?.dialogue_or_action;
  return `Scene ${scene.scene_number} (${scene.location || 'unspecified location'}): ` +
    `${scene.emotional_beat || scene.scene_description || 'no summary'}` +
    (lastLine ? ` — closed on: "${lastLine}"` : '');
}


/**
 * Enforce the semantic contract before shot data reaches any downstream model.
 * Quotes are the spoken-audio channel; actions/emotions are visual description only.
 * This is intentionally conservative: quoted strings that look like third-person
 * stage directions are unquoted, and silent shots cannot retain quoted text.
 */
function _sanitizeDialogueOrActionSemantics(shot) {
  if (!shot || typeof shot !== 'object') return shot;

  const out = { ...shot };
  let text = typeof out.dialogue_or_action === 'string' ? out.dialogue_or_action.trim() : '';
  const mode = String(out.tts_mode || '').toLowerCase();

  // Quotes are reserved for spoken dialogue/phone speech. Internal voice-over is intentionally unquoted.
  const audibleMode = mode === 'spoken' || mode === 'phone_vo' || mode === 'internal_monologue';

  const actionLead = /^(?:the\s+)?(?:[A-Z][A-Za-z.'’-]*(?:\s+[A-Z][A-Za-z.'’-]*){0,4})\s+(?:looks?|stares?|glances?|watches?|turns?|walks?|steps?|moves?|reaches?|holds?|opens?|closes?|checks?|reads?|types?|sits?|stands?|leans?|smiles?|frowns?|nods?|shakes?|breathes?|pauses?|grips?|clenches?|raises?|lowers?|takes?|puts?|pulls?|pushes?|enters?|leaves?|crosses?)\b/i;

  // Process line-by-line so multi-shot/speaker formatting remains intact.
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const cleaned = lines.map(line => {
    const speakerMatch = line.match(/^\s*([^:]{1,80}):\s*(.*)$/);
    const body = speakerMatch ? speakerMatch[2].trim() : line;

    // If the quoted content itself is plainly an action sentence, unquote it.
    const spans = body.match(/["“”][^"“”]+["“”]/g) || [];
    let next = body;
    for (const span of spans) {
      const inner = span.slice(1, -1).trim();
      if (actionLead.test(inner) || /^(?:he|she|they|the\s+(?:man|woman|person|doctor|detective))\s+(?:looks?|turns?|walks?|steps?|moves?|reads?|checks?|opens?|closes?)/i.test(inner)) {
        next = next.replace(span, inner);
      }
    }

    // Silent/action shots: strip every quotation mark. They are not an audio channel.
    if (!audibleMode || mode === 'ambient' || mode === 'internal_monologue') {
      next = next.replace(/["“”]/g, '');
    }
    return speakerMatch ? `${speakerMatch[1].trim()}: ${next.trim()}` : next.trim();
  }).filter(Boolean);

  out.dialogue_or_action = cleaned.join('\n');

  if (mode === 'internal_monologue') {
    out.dialogue_or_action = out.dialogue_or_action.replace(/(\(V\.O\.\)\s*:\s*)[\"“”]+|[\"“”]+(?=\s*$)/g, '$1');
  }

  // End-frame fields are never an audio channel. Remove accidental wrapping quotes
  // so they can never be interpreted as speech downstream.
  // These fields are visual/action channels, never speech channels. Strip quote glyphs
  // throughout the value so a quoted narrative fragment cannot be promoted later by
  // an LTX speech extractor. Exact spoken words belong ONLY in dialogue_or_action.
  for (const key of ['shot_description', 'shot_purpose', 'character_positions', 'start_frame_state', 'end_frame_state', 'end_frame_transition', 'next_shot_continuity', 'temporal_arc', 'environmental_story_beat', 'emotional_subtext', 'scene_environment', 'subject_motion', 'ambient_motion', 'camera_movement', 'focal_length_hint']) {
    if (typeof out[key] === 'string') {
      out[key] = out[key].trim()
        .replace(/[“”\"']/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  // If a supposedly spoken shot contains only an action sentence, downgrade it to ambient.
  if (mode === 'spoken') {
    const probe = out.dialogue_or_action.replace(/^[^:]{1,80}:\s*/, '').trim();
    if (!/["“”][^"“”]+["“”]/.test(probe) && actionLead.test(probe)) {
      out.tts_mode = 'ambient';
      out.dialogue_or_action = probe;
    }
  }

  return out;
}

function _hasAudibleSceneSpeech(shot) {
  if (!shot || typeof shot !== 'object') return false;
  const mode = String(shot.tts_mode || '').toLowerCase();
  const text = typeof shot.dialogue_or_action === 'string' ? shot.dialogue_or_action.trim() : '';
  if (!text) return false;
  if (mode === 'internal_monologue') {
    return /\(V\.O\.\)\s*:\s*\S+/i.test(text);
  }
  if (mode === 'spoken' || mode === 'phone_vo') {
    return /["“”]\s*[^"“”]{3,}\s*["“”]/.test(text);
  }
  return false;
}

function _resolveSceneSpeaker(scene, shot, characters) {
  const declaredNames = [
    ...(Array.isArray(scene?.characters_present) ? scene.characters_present : []),
    ...(Array.isArray(shot?.characters_in_shot) ? shot.characters_in_shot : []),
  ].filter(Boolean).map(String);

  if (!declaredNames.length) return null;

  const catalog = Array.isArray(characters) ? characters : [];
  const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  for (const name of declaredNames) {
    const exact = catalog.find(c => normalize(c.name) === normalize(name));
    if (exact) return exact.name;
  }
  const fallback = catalog.find(c => declaredNames.some(name => normalize(c.name).includes(normalize(name)) || normalize(name).includes(normalize(c.name))));
  return fallback?.name || declaredNames[0] || null;
}

function _extractSpeakerNames(shot) {
  const names = [];
  for (const n of Array.isArray(shot?.speakers_in_shot) ? shot.speakers_in_shot : []) {
    if (n) names.push(String(n).trim());
  }
  const text = String(shot?.dialogue_or_action || '');
  for (const match of text.matchAll(/(^|\n)\s*([^:\n]{1,80}):\s*["“]/g)) {
    if (match[2]) names.push(match[2].trim());
  }
  return [...new Set(names)];
}

function _hasMultiSpeakerExchange(shot) {
  if (!shot || String(shot.tts_mode || '').toLowerCase() !== 'spoken') return false;
  const speakers = _extractSpeakerNames(shot);
  const text = String(shot.dialogue_or_action || '');
  const quoted = text.match(/["“][^"”]{3,}["”]/g) || [];
  return speakers.length >= 2 && quoted.length >= 2;
}

async function _ensureAgnesConversationalScene(scene, { storyline, characters }) {
  if (!scene || !Array.isArray(scene.shots) || !scene.shots.length) return scene;
  const visible = [...new Set([
    ...(Array.isArray(scene.characters_present) ? scene.characters_present : []),
    ...scene.shots.flatMap(s => Array.isArray(s.characters_in_shot) ? s.characters_in_shot : []),
  ].filter(Boolean).map(String))];
  if (visible.length < 2) return _ensureSpeechForSceneSingle(scene, { storyline, characters });
  if (scene.shots.some(_hasMultiSpeakerExchange)) return scene;

  const candidate = scene.shots.find(s => (s.characters_in_shot || []).length >= 2)
    || scene.shots.find(s => (s.character_staging || []).length >= 2)
    || scene.shots[Math.min(1, scene.shots.length - 1)];
  const prompt = `
You are refining one already-written live-action movie scene for AGNES.
Preserve the existing plot event, location, character identities, physical action and emotional meaning.
Turn ONE existing shot into a natural shared performance between at least two characters who are already
present together. The exchange should feel like the supplied reference movie style: direct, emotionally
specific, reactive, conversational, with visible listening and body language. Do not add a new plot event.

SCENE:
${scene.scene_description || ''}
EMOTIONAL BEAT:
${scene.emotional_beat || ''}
LOCATION:
${scene.location || ''}
CHARACTERS:
${visible.join(', ')}

CANDIDATE SHOT:
${JSON.stringify({
  shot_description: candidate.shot_description,
  start_frame_state: candidate.start_frame_state,
  end_frame_state: candidate.end_frame_state,
  characters_in_shot: candidate.characters_in_shot,
  character_staging: candidate.character_staging,
  dialogue_or_action: candidate.dialogue_or_action,
  temporal_arc: candidate.temporal_arc,
}).slice(0, 14000)}

Return JSON ONLY:
{
  "tts_mode": "spoken",
  "speakers_in_shot": ["Character A", "Character B"],
  "dialogue_or_action": "CHARACTER A: \\\"brief spoken line\\\" CHARACTER B: \\\"brief response\\\" CHARACTER A: \\\"brief follow-up if needed\\\"",
  "delivery_note": "Natural overlapping reactions, eye contact, pauses, breathing and visible listening.",
  "subject_motion": "Concrete body action continuing through the exchange.",
  "temporal_arc": "Beginning state → conversational turn → reaction → changed end state."
}
Rules:
- Use 2 or 3 short turns unless the existing shot can truthfully support 4.
- Preserve exact character names from the visible cast.
- Every quoted phrase is actually spoken aloud.
- Do not create subtitles, narration, internal voice-over or a new event.
- The characters must visibly react to each other.
`;

  try {
    const repair = await callLLM(
      `${DIRECTOR_PERSONA}\n${AGNES_CONVERSATIONAL_RULES}\nReturn JSON only.`,
      prompt,
      900,
      { useStream: false, temperature: 0.48 }
    );
    const chosen = repair && typeof repair === 'object' ? repair : {};
    const speakers = Array.isArray(chosen.speakers_in_shot) ? chosen.speakers_in_shot.map(String).filter(Boolean).slice(0, 4) : [];
    const dialogue = String(chosen.dialogue_or_action || '').trim();
    if (speakers.length < 2 || !dialogue || !/["“][^"”]{3,}["”]/.test(dialogue)) throw new Error('Agnes conversational repair did not produce a real multi-speaker exchange');

    candidate.tts_mode = 'spoken';
    candidate.speakers_in_shot = speakers;
    candidate.speaker_name = speakers[0];
    candidate.characters_in_shot = [...new Set([...(candidate.characters_in_shot || []), ...speakers])];
    candidate.shot_pacing_type = 'dialogue_full';
    candidate.dialogue_or_action = dialogue;
    if (chosen.delivery_note) candidate._delivery_note = String(chosen.delivery_note).replace(/["“”]/g, '').trim();
    if (chosen.subject_motion) candidate.subject_motion = String(chosen.subject_motion).trim();
    if (chosen.temporal_arc) candidate.temporal_arc = String(chosen.temporal_arc).trim();
    candidate._speech_guarded = true;
    candidate._speech_guard_reason = 'agnes-multi-speaker-conversational-repair';
    return scene;
  } catch (err) {
    console.warn(`[SpeechGuard:Agnes] Scene ${scene.scene_number} multi-speaker repair failed: ${err.message}`);
    return _ensureSpeechForSceneSingle(scene, { storyline, characters });
  }
}

async function _ensureSpeechForSceneSingle(scene, { storyline, characters }) {
  if (!scene || !Array.isArray(scene.shots) || !scene.shots.length) return scene;
  if (scene.shots.some(_hasAudibleSceneSpeech)) return scene;

  const candidate = scene.shots.find(s => Array.isArray(s.characters_in_shot) && s.characters_in_shot.length && !s._is_reaction_insert)
    || scene.shots.find(s => Array.isArray(s.characters_in_shot) && s.characters_in_shot.length)
    || scene.shots[0];
  const speaker = _resolveSceneSpeaker(scene, candidate, characters);
  if (!speaker) {
    console.warn(`[SpeechGuard] Scene ${scene.scene_number} has no declared character; keeping it ambient.`);
    return scene;
  }
  const characterRow = (Array.isArray(characters) ? characters : []).find(c => String(c.name).toLowerCase() === String(speaker).toLowerCase()) || {};
  const prompt = `
Scene ${scene.scene_number}: ${scene.scene_description || ''}
Emotional beat: ${scene.emotional_beat || ''}
Location: ${scene.location || ''}
Characters present: ${(scene.characters_present || []).join(', ')}
Chosen shot: ${JSON.stringify({
    shot_description: candidate.shot_description,
    emotional_subtext: candidate.emotional_subtext,
    environmental_story_beat: candidate.environmental_story_beat,
    temporal_arc: candidate.temporal_arc,
    characters_in_shot: candidate.characters_in_shot,
  }).slice(0, 7000)}
Speaker candidate: ${speaker}
Character context: ${String(characterRow.description || characterRow.role || '').slice(0, 1200)}

The scene currently has NO audible speech. Add one concise, contextually necessary audio beat to the chosen shot.
Prefer a meaningful spoken line when the scene naturally supports it; otherwise use the character's internal voice-over thought.
Return JSON ONLY: {"tts_mode":"spoken | internal_monologue","speaker":"${speaker}","text":"8-25 words","delivery_note":"brief unquoted delivery guidance"}
`;
  try {
    const repair = await callLLM(
      `${DIRECTOR_PERSONA}\nSPEECH COVERAGE GUARD: use contextually necessary human speech; never invent filler.`,
      prompt,
      500,
      { useStream: false, temperature: 0.20 }
    );
    const mode = String(repair?.tts_mode || '').toLowerCase() === 'spoken' ? 'spoken' : 'internal_monologue';
    const spokenText = String(repair?.text || '').trim().replace(/^['"“”]+|['"“”]+$/g, '');
    if (!spokenText) throw new Error('Speech guard returned empty text');
    candidate.tts_mode = mode;
    candidate.speaker_name = speaker;
    candidate.speakers_in_shot = [speaker];
    candidate.characters_in_shot = Array.from(new Set([...(candidate.characters_in_shot || []), speaker]));
    candidate.shot_pacing_type = mode === 'spoken' ? 'dialogue_mid' : 'slow_dramatic';
    candidate._speech_guarded = true;
    candidate._speech_guard_reason = mode === 'spoken' ? 'contextual-dialogue' : 'contextual-internal-monologue';
    candidate.dialogue_or_action = mode === 'spoken'
      ? `${speaker}: "${spokenText}"${repair?.delivery_note ? ` ${String(repair.delivery_note).replace(/["“”]/g, '')}` : ''}`
      : `${speaker} (V.O.): ${spokenText}`;
    return scene;
  } catch (err) {
    const context = String(candidate.emotional_subtext || scene.emotional_beat || scene.scene_description || 'this moment').trim()
      .replace(/["“”]/g, '').replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
    const fallbackThought = `I cannot ignore what this moment is telling me about ${context}.`;
    candidate.tts_mode = 'internal_monologue';
    candidate.speaker_name = speaker;
    candidate.speakers_in_shot = [speaker];
    candidate.characters_in_shot = Array.from(new Set([...(candidate.characters_in_shot || []), speaker]));
    candidate.shot_pacing_type = 'slow_dramatic';
    candidate._speech_guarded = true;
    candidate._speech_guard_reason = 'contextual-internal-monologue-fallback';
    candidate.dialogue_or_action = `${speaker} (V.O.): ${fallbackThought}`;
    console.warn(`[SpeechGuard] Scene ${scene.scene_number} used contextual internal-monologue fallback after repair failure: ${err.message}`);
    return scene;
  }
}

/**
 * Enforce audible speech coverage at scene level before any image/video
 * generation layer runs. This is intentionally semantic: it uses the actual
 * scene context and locked cast rather than inventing generic dialogue.
 */
async function ensureSceneSpeechCoverage(script, { storyline, characters } = {}) {
  if (!script || !Array.isArray(script.scenes)) return script;

  // A media-generation resume is consuming an already-locked production script.
  // Do NOT run speech insertion/rewriting again: that can mutate a persisted
  // multi-turn conversation or reject a valid historical formatting shape before
  // the media loop even starts. Fresh/script-processing runs still receive the
  // full speech coverage gate below.
  const checkpointStage = String(script?.checkpoint_state?.stage || '').trim().toLowerCase();
  if (['media_generation_ready', 'media_generation', 'media_complete'].includes(checkpointStage)) {
    console.log(`[ScriptWriter] ↺ Preserved persisted speech/dialogue metadata during ${checkpointStage} media resume`);
    return script;
  }
  for (const scene of script.scenes) {
    if (IS_AGNES_PROVIDER) {
      await _ensureAgnesConversationalScene(scene, { storyline, characters });
    } else {
      await _ensureSpeechForSceneSingle(scene, { storyline, characters });
    }
    for (let shotIndex = 0; shotIndex < (scene.shots || []).length; shotIndex++) {
      const shot = scene.shots[shotIndex];
      _sanitizeDialogueOrActionSemantics(shot);
      scene.shots[shotIndex] = await _resolveShotSpeechWithRepair(shot, scene, characters, {
        sceneNo: scene.scene_number, shotIndex: shotIndex + 1,
      });
    }
  }
  return script;
}

function _fallbackSceneShots(scene) {
  const target = Math.max(2, Math.min(5, Number(scene?.shot_count_target) || 3));
  const characters = Array.isArray(scene?.characters_present) ? scene.characters_present.filter(Boolean) : [];
  const speaker = characters[0] || null;
  const base = String(scene?.scene_description || 'The scene unfolds with controlled visual action.').replace(/\s+/g, ' ').trim();
  const emotion = String(scene?.emotional_beat || 'The emotional pressure in the scene changes.').replace(/\s+/g, ' ').trim();
  const location = String(scene?.location || 'The established location').replace(/\s+/g, ' ').trim();
  const lighting = String(scene?.lighting_design || 'natural cinematic light').replace(/\s+/g, ' ').trim();
  const common = {
    shot_pacing_type: 'dialogue_mid',
    narrative_complexity: 'medium',
    camera_movement: 'slow push-in',
    focal_length_hint: 'normal 35mm',
    motion_level: 'low',
    motion_intensity: 0.25,
    ambient_motion: 'gentle',
    pose_state: speaker ? 'standing' : 'none',
    depth_layering: `Foreground details frame the ${location}; the characters remain readable in the midground with the environment receding behind them.`,
    scene_environment: `${location}, ${lighting}`,
    environment_sound: `Natural room tone and subtle environmental sound from ${location}.`,
    music_cue: 'none',
    music_reason: '',
    subject_motion: 'Small natural movement continues through the moment while the emotional beat develops.',
    temporal_arc: `${base} The moment develops into ${emotion} and settles into a clear end state.`,
    environmental_story_beat: `${lighting} and the surrounding environment visibly reinforce ${emotion}.`,
  };
  const shots = [];
  for (let i = 0; i < target; i++) {
    const isFirst = i === 0;
    const isLast = i === target - 1;
    const charLine = speaker
      ? `${speaker} remains present and emotionally engaged with the immediate situation.`
      : 'The environment carries the scene without inventing a new character.';
    const secondSpeaker = IS_AGNES_PROVIDER && characters.length > 1 ? characters[1] : null;
    const dialogue = speaker
      ? (secondSpeaker
        ? `${speaker}: "We need to decide now."\n${secondSpeaker}: "Then say what you came here to say."\n${speaker}: "I came because I couldn't leave you alone in this."`
        : `${speaker} (V.O.): I know this moment matters, and I cannot pretend it does not.`)
      : '';
    shots.push({
      ...common,
      shot_index: i + 1,
      shot_type: isFirst ? 'WS' : isLast ? 'CU' : 'MCU',
      shot_purpose: isFirst ? 'Establish the dramatic situation and emotional temperature.' : isLast ? 'Land the scene on a meaningful emotional state.' : 'Advance the immediate emotional beat without changing the established world.',
      shot_description: `${charLine} ${base}`,
      image_prompt: `Vertical 9:16 photorealistic cinematic still frame in ${location}, ${lighting}. ${base} Freeze one clear visual instant with ${speaker || 'the environment'} as the visible subject, natural composition, realistic depth, grounded posture and expressive eyeline. Do not depict speech, lip movement, camera motion, animation or audio.`,
      characters_in_shot: characters,
      character_staging: speaker ? [{
        name: speaker,
        screen_position: 'screen-center',
        depth: 'midground',
        facing_toward: 'the immediate story focus',
        action: 'remains present and emotionally engaged with the immediate situation',
        pose: isFirst ? 'grounded neutral stance' : isLast ? 'settled final pose' : 'natural conversational stance',
        eyeline: 'the immediate story focus',
        interaction: 'engaged with the scene without inventing another person',
        speaking: Boolean(speaker),
        visual_identity: 'preserve the locked CAST identity'
      }] : [],
      speakers_in_shot: secondSpeaker ? [speaker, secondSpeaker] : (speaker ? [speaker] : []),
      character_positions: speaker ? `${speaker} is framed at screen-center in the midground, facing the immediate story focus, with a grounded readable pose.` : 'No character is required; the environment remains the subject.',
      start_frame_state: `${speaker || 'The environment'} begins in the established state for ${location}, with ${lighting}.`,
      end_frame_state: `${speaker || 'The environment'} settles into a visible state that reflects ${emotion}.`,
      emotional_subtext: emotion,
      dialogue_or_action: dialogue || `${base} The surrounding environment changes subtly as the scene settles into its next beat.`,
      tts_mode: secondSpeaker ? 'spoken' : (speaker ? 'internal_monologue' : 'ambient'),
      speaker_name: speaker || undefined,
      end_frame_transition: isLast ? `The scene holds on the final emotional state established by ${emotion}.` : 'The ending gaze and environmental state create a direct handoff into the next shot.',
      next_shot_continuity: isLast ? 'Carry the emotional state forward into the next scene.' : 'Inherit the established gaze, posture, light, environment and unresolved emotional beat.',
      duration: _SCRIPT_MAX_DURATION,
      clip_duration: _SCRIPT_MAX_DURATION,
      _fallback_generated: true,
      _speech_guarded: Boolean(speaker),
      _speech_guard_reason: speaker ? 'deterministic-internal-monologue-fallback' : undefined,
    });
  }
  return shots;
}

function _clampArray(value, max) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function _normalizeSceneContinuityBible(raw) {
  const bible = raw && typeof raw === 'object' ? raw : {};
  return {
    axis_of_action: typeof bible.axis_of_action === 'string' ? bible.axis_of_action.trim() : '',
    line_cross_shots: _clampArray(bible.line_cross_shots, 20)
      .map(v => Number(v))
      .filter(Number.isFinite),
    line_cross_reason: typeof bible.line_cross_reason === 'string' ? bible.line_cross_reason.trim() : '',
    wardrobe_lock: _clampArray(bible.wardrobe_lock, 20)
      .map(row => ({
        name: String(row?.name || '').trim(),
        state: String(row?.state || '').trim(),
      }))
      .filter(row => row.name && row.state),
    active_props: _clampArray(bible.active_props, 20)
      .map(row => ({
        prop: String(row?.prop || '').trim(),
        state: String(row?.state || '').trim(),
      }))
      .filter(row => row.prop && row.state),
    lighting_lock: typeof bible.lighting_lock === 'string' ? bible.lighting_lock.trim() : '',
  };
}

/**
 * Cheap, non-fatal drift detector for the 180-degree rule. This is a
 * heuristic sanity check, not a hard gate: real line-crosses are a valid
 * directorial choice (tracked in scene_continuity_bible.line_cross_shots),
 * and screen-position labels are coarse — so this only WARNS in logs, it
 * never blocks generation or rewrites a shot. Scans the WHOLE scene in
 * order (not just adjacent pairs), so it catches a flip several cuts later
 * just as well as a flip between two consecutive shots.
 */
function _warnAxisOfActionDrift(sceneNo, orderedShots, bible) {
  if (!Array.isArray(orderedShots) || orderedShots.length < 2) return;

  const lineCrossIndices = new Set((bible.line_cross_shots || []).map(Number));
  // character name -> last observed non-center screen side ('left' | 'right')
  const lastSide = new Map();

  const sideOf = (screenPosition) => {
    const p = String(screenPosition || '').toLowerCase();
    if (p.includes('left')) return 'left';
    if (p.includes('right')) return 'right';
    return null; // center/unknown — not diagnostic, skip
  };

  for (const shot of orderedShots) {
    const shotIndex = Number(shot?.shot_index);
    const staging = Array.isArray(shot?.character_staging) ? shot.character_staging : [];
    const isLineCrossShot = lineCrossIndices.has(shotIndex);

    for (const entry of staging) {
      const name = String(entry?.name || '').trim();
      const side = sideOf(entry?.screen_position);
      if (!name || !side) continue;

      const previousSide = lastSide.get(name);
      if (previousSide && previousSide !== side && !isLineCrossShot) {
        console.warn(
          `[ScriptWriter] AXIS-OF-ACTION WARNING | S${sceneNo}/idx${shotIndex}: ` +
          `"${name}" flips from screen-${previousSide} to screen-${side} without an authored ` +
          `line-cross in scene_continuity_bible.line_cross_shots. Verify this is intentional; ` +
          `otherwise it will read as a geography error, not a stylistic cut.`
        );
      }
      lastSide.set(name, side);
    }
  }
}

function _serializeRepairPayload(value) {
  return JSON.stringify(value, (_key, item) => {
    // Buffer.toJSON() runs before the replacer. Convert its full byte array
    // losslessly to base64 so no binary payload is silently omitted or cut.
    if (item && item.type === 'Buffer' && Array.isArray(item.data)) {
      return {
        __streamverse_type: 'Buffer',
        encoding: 'base64',
        data: Buffer.from(item.data).toString('base64'),
      };
    }
    if (Buffer.isBuffer(item)) {
      return {
        __streamverse_type: 'Buffer',
        encoding: 'base64',
        data: item.toString('base64'),
      };
    }
    return item;
  }, 2);
}

function _applySceneSpeechRepairPatch(originalShot, patch, lockedShot) {
  const repairableFields = new Set([
    'dialogue_or_action',
    'speaker',
    'speaker_name',
    'speakers_in_shot',
    'characters_in_shot',
  ]);
  const contentPatch = Object.fromEntries(
    Object.entries(patch || {}).filter(([key]) => repairableFields.has(key))
  );

  return {
    ...originalShot,
    ...contentPatch,
    scene_number: Number(lockedShot.scene_number),
    shot_index: Number(lockedShot.shot_index),
  };
}

function _validatePersistedSceneShots(sceneNumber, shots, lockedShots, sceneRow, characters = []) {
  const expectedIds = lockedShots.map(shot => `S${Number(shot.scene_number)}/${Number(shot.shot_index)}`);
  const returnedIds = Array.isArray(shots)
    ? shots.map(shot => `S${Number.isFinite(Number(shot?.scene_number)) ? Number(shot.scene_number) : 'n/a'}/${Number.isFinite(Number(shot?.shot_index)) ? Number(shot.shot_index) : 'n/a'}`)
    : [];

  if (!Array.isArray(shots) || shots.length !== lockedShots.length) {
    return {
      valid: false,
      type: 'shape',
      message: !Array.isArray(shots) || shots.length === 0
        ? `Scene S${sceneNumber} returned no usable shot objects; the persisted scene plan requires ${lockedShots.length} shots with IDs ${JSON.stringify(expectedIds)}.`
        : `Scene S${sceneNumber} returned ${shots.length} shots; the persisted scene plan requires ${lockedShots.length} shots with IDs ${JSON.stringify(expectedIds)}.`,
      expectedIds,
      returnedIds,
    };
  }

  const idsMatch = shots.every((shot, index) =>
    Number(shot?.scene_number) === Number(lockedShots[index]?.scene_number) &&
    Number(shot?.shot_index) === Number(lockedShots[index]?.shot_index)
  );
  if (!idsMatch) {
    return {
      valid: false,
      type: 'ids',
      message: `Scene S${sceneNumber} requires the exact persisted IDs ${JSON.stringify(expectedIds)} in order; model returned ${JSON.stringify(returnedIds)}.`,
      expectedIds,
      returnedIds,
    };
  }

  const normalizedShots = [];
  const failedShots = [];
  for (let index = 0; index < shots.length; index++) {
    try {
      const checked = _enforceShotSpeechMetadata(shots[index], sceneRow, characters, { hardFail: false });
      normalizedShots.push(checked.shot);
      if (!checked.valid) {
        failedShots.push({
          index,
          shotIndex: Number(shots[index]?.shot_index),
          code: checked.code,
          reason: checked.reason || 'speech metadata failed validation',
        });
      }
    } catch (error) {
      normalizedShots.push({ ...shots[index] });
      failedShots.push({
        index,
        shotIndex: Number(shots[index]?.shot_index),
        reason: error.message || String(error),
      });
    }
  }

  if (failedShots.length) {
    return {
      valid: false,
      type: 'content',
      message: failedShots
        .map(failure => `S${sceneNumber}/idx${failure.shotIndex}: ${failure.reason}`)
        .join('; '),
      expectedIds,
      returnedIds,
      failedShots,
      normalizedShots,
    };
  }

  return { valid: true, type: 'valid', shots: normalizedShots, expectedIds, returnedIds };
}

async function _writeSceneShotsSequential({
  scenes,
  characterBlock,
  characters = [],
  shotSimulation,
  existingScenes = [],
  checkpoint = null,
}) {
  const totalScenes = scenes.length;
  const scenesWithShots = [];
  const priorByScene = new Map(
    (Array.isArray(existingScenes) ? existingScenes : []).map(scene => [Number(scene.scene_number), scene])
  );

  // Resume only completed scene checkpoints, in strict scene order, without renumbering them.
  for (const scene of scenes) {
    const sceneNo = Number(scene.scene_number);
    const lockedShots = (shotSimulation?.shots || [])
      .filter(s => Number(s.scene_number) === sceneNo)
      .sort((a, b) => Number(a.shot_index) - Number(b.shot_index));
    const prior = priorByScene.get(sceneNo);
    const priorValidation = prior
      ? _validatePersistedSceneShots(
          sceneNo,
          prior.shots,
          lockedShots,
          scene,
          characters
        )
      : null;
    if (!priorValidation?.valid) break;

    scenesWithShots.push({ ...scene, ...prior, shots: priorValidation.shots });
    console.log(`[ScriptWriter] ↺ Restored scene-shot checkpoint S${sceneNo} (${lockedShots.length}/${lockedShots.length} shots)`);
  }

  for (let idx = scenesWithShots.length; idx < totalScenes; idx++) {
    const scene = scenes[idx];
    const sceneNo = Number(scene.scene_number);
    const lockedShots = (shotSimulation?.shots || [])
      .filter(s => Number(s.scene_number) === sceneNo)
      .sort((a, b) => Number(a.shot_index) - Number(b.shot_index));

    if (!lockedShots.length) {
      throw new Error(`[ScriptWriter] Cannot write Scene ${sceneNo}: persisted shot_simulation contains no shots for this scene.`);
    }

    const targetShots = lockedShots.length;
    const previousScene = scenesWithShots.length ? scenesWithShots[scenesWithShots.length - 1] : null;
    const previousEnd = previousScene?.shots?.length ? previousScene.shots[previousScene.shots.length - 1] : null;
    const priorSceneState = previousEnd ? {
      scene_number: Number(previousScene.scene_number),
      end_frame_state: previousEnd.end_frame_state || previousEnd.end_state || '',
      next_shot_continuity: previousEnd.next_shot_continuity || previousEnd.handoff_to_next || '',
      // Deliberately exclude prior scene shot_index: IDs are scene-local.
    } : null;

    const lockedIds = lockedShots.map(s => `S${s.scene_number}/${s.shot_index}`);
    const scenePrompt = `
You are writing the cinematic realization of ONE already-locked scene.
This is scene ${idx + 1} of ${totalScenes} in the episode.

AUTHORITATIVE PERSISTED SHOT SIMULATION FOR THIS SCENE:
${JSON.stringify(lockedShots)}

AUTHORITATIVE LOCAL SHOT IDS, IN ORDER:
${JSON.stringify(lockedIds)}

IMPORTANT IDENTITY RULE:
These persisted shot IDs are the identity of the shots you are writing. Do not continue numbering from another scene. Do not invent an episode-global sequence. Return the exact local IDs shown above.

PRIOR SCENE TERMINAL CONTINUITY, IF ANY:
${JSON.stringify(priorSceneState || {})}

CURRENT SCENE:
${JSON.stringify({
      scene_number: sceneNo,
      scene_description: scene.scene_description || '',
      emotional_beat: scene.emotional_beat || '',
      location: scene.location || '',
      lighting_design: scene.lighting_design || '',
      camera_language: scene.camera_language || '',
      characters_present: scene.characters_present || [],
    })}

CAST IDENTITY LOCKS:
${characterBlock}

Write exactly ${targetShots} ordered shots for this scene in ONE response. Each shot must preserve the corresponding persisted shot's causal plan, start/end state, handoff, dialogue intent, and character changes while expanding it into a production-ready cinematic shot.
${IS_AGNES_PROVIDER ? 'Because AGNES is selected, prefer natural shared shots where multiple visible characters can speak and react in the same composition when the drama supports it. Do not split the exchange into isolated talking heads merely for formatting convenience.' : ''}
${TRAVEL_CONTINUITY_RULES}

SHOT-TO-SHOT CONTINUITY:
- Shot ${lockedIds[0]} begins from the scene opening / prior-scene terminal state above.
- Every following shot begins from the immediately preceding shot's terminal state.
- Preserve the persisted order. Do not merge, skip, split, or reorder the locked shots.
- Dialogue belongs in dialogue_or_action with quotation marks only for exact words actually spoken.
- SPEAKER CONTRACT: every spoken or phone dialogue line MUST be assigned to a named character from CAST. The corresponding speaker/speaker_name and speakers_in_shot metadata MUST NOT be empty.
- If dialogue_or_action is spoken and contains a single unlabelled quoted utterance, its speaker must be deterministic from the locked shot staging; prefix it with NAME: before returning the shot.
- For multiple turns, every quoted utterance must have an explicit NAME: prefix in chronological order.
- image_prompt is the exact frozen opening frame for the still-image stage; do not put motion, speaking, camera movement, audio, or temporal instructions into it. For travel, the image must show the TRUE opening state of that travel stage, never the final destination by anticipation.
- ltx_shot_description is the natural chronological image-to-video prompt for the selected provider. Its length must match the complexity of the shot; there is no hard word cap.
- Decide this scene's scene_continuity_bible (axis of action, wardrobe_lock, active_props, lighting_lock) before writing shot 1, and keep every shot's staging consistent with it for the whole scene — including shots several cuts after a prop or character's screen side was last mentioned. Return it once, at the top level of your response.

${SHOT_SCHEMA}`;

    let result = await callLLM(
      SHOT_SYSTEM_PROMPT,
      scenePrompt,
      undefined,
      { useStream: false, temperature: 0.25 }
    );

    let repairAttempt = 0;
    const maxRepairAttempts = 3;
    let validation = _validatePersistedSceneShots(
      sceneNo,
      result?.shots,
      lockedShots,
      scene,
      characters
    );
    while (!validation.valid && repairAttempt < maxRepairAttempts) {
      const rawShots = Array.isArray(result?.shots) ? result.shots : [];
      repairAttempt += 1;
      const validationError = validation.message;
      console.warn(
        `[ScriptWriter] Scene-shot validation failed S${sceneNo} ` +
        `type=${validation.type} repairAttempt=${repairAttempt}/${maxRepairAttempts}: ${validationError}`
      );

      if (validation.type === 'shape') {
        // A missing or wrong-sized payload cannot be repaired with an ID patch.
        result = await callLLM(
          `${SHOT_SYSTEM_PROMPT}\nThe previous scene-shot response failed validation. Regenerate this same scene completely.`,
          `${scenePrompt}\n\nVALIDATION ERROR FROM PREVIOUS RESPONSE:\n${validationError}\n\nReturn exactly ${targetShots} shots and preserve the persisted scene-shot order.`,
          undefined,
          { useStream: false, temperature: 0.12 }
        );
      } else if (validation.type === 'ids') {
        // IDs alone are repaired only when they actually differ. Content is
        // never sent through this narrow identifier-only repair path.
        const repaired = await callLLM(
          `${DIRECTOR_PERSONA}\nYou are repairing ONLY the shot identifiers of an already-authored scene. Do not rewrite any cinematic content.`,
          `SCENE: S${sceneNo}\nEXPECTED PERSISTED IDS: ${JSON.stringify(lockedIds)}\nVALIDATION ERROR: ${validationError}\nReturn ONLY {"corrected_ids":[{"position":1,"scene_number":${Number(lockedShots[0].scene_number)},"shot_index":${Number(lockedShots[0].shot_index)}}, ...]} with exactly ${targetShots} entries.`,
          undefined,
          { useStream: false, temperature: 0.02 }
        );

        const corrected = Array.isArray(repaired?.corrected_ids) ? repaired.corrected_ids : [];
        const usable = corrected.length === targetShots && corrected.every((id, i) =>
          Number(id?.position) === i + 1 &&
          Number(id?.scene_number) === Number(lockedShots[i]?.scene_number) &&
          Number(id?.shot_index) === Number(lockedShots[i]?.shot_index)
        );

        if (usable) {
          result = { ...result, shots: rawShots.map((shot, i) => ({
            ...shot,
            scene_number: Number(lockedShots[i].scene_number),
            shot_index: Number(lockedShots[i].shot_index),
          })) };
        } else {
          console.warn(`[ScriptWriter] Shot-ID repair returned unusable corrected_ids; the next bounded pass will regenerate the scene.`);
          result = await callLLM(
            `${SHOT_SYSTEM_PROMPT}\nThe identifier-only repair failed. Regenerate the complete scene response.`,
            `${scenePrompt}\n\nVALIDATION ERROR:\n${validationError}\n\nReturn exactly ${targetShots} shots with these exact IDs in order: ${JSON.stringify(lockedIds)}.`,
            undefined,
            { useStream: false, temperature: 0.12 }
          );
        }
      } else if (validation.type === 'content') {
        const nextShots = rawShots.slice();
        for (const failure of validation.failedShots) {
          const originalShot = nextShots[failure.index];
          const serializedShot = _serializeRepairPayload(originalShot);
          const previousShot = failure.index > 0 ? nextShots[failure.index - 1] : null;
          const followingShot = failure.index + 1 < nextShots.length ? nextShots[failure.index + 1] : null;
          const lockedShot = lockedShots[failure.index];
          const repairContract = failure.code === 'SPEAKER_TURN_CONTRACT_FAILED'
            ? `${_buildTurnOwnershipRepairInstruction(originalShot)}
Return ONLY {"patch":{"speakers_in_shot":${_speakerTurnArrayTemplate(originalShot)}}}. The array must have exactly the requested number of entries, including repeated names. Do not return a deduplicated roster or change dialogue text.`
            : `For spoken/phone_vo with no quoted audible words, add a concise quoted line grounded in that locked shot's dialogue_purpose rather than changing its dialogue mode. For spoken/phone_vo dialogue, provide deterministic named-speaker metadata; for internal_monologue, identify its exact speaker.`;
          const repaired = await callLLM(
            `${SHOT_SYSTEM_PROMPT}\nYou repair only the content fields responsible for the reported speech-contract failure in one already-authored shot. Do not rewrite the scene or change its shot identity.`,
            `SCENE: S${sceneNo}
SCENE CONTEXT:
${_serializeRepairPayload({
              scene_number: sceneNo,
              scene_description: scene.scene_description || '',
              emotional_beat: scene.emotional_beat || '',
              location: scene.location || '',
              characters_present: scene.characters_present || [],
            })}
CAST IDENTITY LOCKS:
${characterBlock}

LOCKED SHOT SIMULATION:
${_serializeRepairPayload(lockedShot)}

CONTENT VALIDATION ERROR:
${failure.reason}

LOCKED SHOT ID: S${sceneNo}/${failure.shotIndex}
PREVIOUS AUTHORED SHOT:
${_serializeRepairPayload(previousShot)}

CURRENT AUTHORED SHOT — complete, untruncated payload:
${serializedShot}

NEXT AUTHORED SHOT:
${_serializeRepairPayload(followingShot)}

Return ONLY {"patch":{...}} with the smallest set of corrected semantic fields needed to pass the speech contract. Keep all valid existing values, preserve exact dialogue words unless the error requires repairing missing or malformed dialogue, and do not alter scene_number, shot_index, story events, character identities, image buffers, or unrelated fields. ${repairContract}`,
            1800,
            { useStream: false, temperature: 0.12 }
          );

          const patchCandidate = repaired?.patch || repaired?.corrected_shot || repaired;
          const patch = patchCandidate && typeof patchCandidate === 'object' && !Array.isArray(patchCandidate)
            ? { ...patchCandidate }
            : null;
          if (!patch) {
            console.warn(`[ScriptWriter] Content repair returned no patch for S${sceneNo}/idx${failure.shotIndex}; preserving the complete authored shot for the next bounded pass.`);
            continue;
          }

          // Apply only speech fields. This makes image/binary preservation
          // structural even if the model returns unrelated replacement data.
          nextShots[failure.index] = _applySceneSpeechRepairPatch(
            originalShot,
            patch,
            lockedShot
          );
        }
        result = { ...result, shots: nextShots };
      }

      validation = _validatePersistedSceneShots(
        sceneNo,
        result?.shots,
        lockedShots,
        scene,
        characters
      );
    }

    if (!validation.valid) {
      throw new Error(
        `[ScriptWriter] Scene S${sceneNo} scene-shot validation failed after ` +
        `${repairAttempt} bounded repair attempt(s): ${validation.message}`
      );
    }
    result = { ...result, shots: validation.shots };

    const sceneContinuityBible = _normalizeSceneContinuityBible(result.scene_continuity_bible);
    console.log(
      `[ScriptWriter] Scene continuity bible S${sceneNo} | ` +
      `axis=${sceneContinuityBible.axis_of_action ? 'locked' : 'none'} ` +
      `wardrobe_tracked=${sceneContinuityBible.wardrobe_lock.length} ` +
      `props_tracked=${sceneContinuityBible.active_props.length} ` +
      `line_cross_shots=${JSON.stringify(sceneContinuityBible.line_cross_shots)}`
    );

    const orderedShots = [];
    for (const rawShot of result.shots) {
      // Normalize every authored shot duration at the writer boundary so a model
      // cannot reintroduce the legacy 10-second value when Agnes is selected.
      const authoredDuration = Number(rawShot?.duration);
      const activeMaxDuration = _SCRIPT_MAX_DURATION;
      const normalizedDuration = Number.isFinite(authoredDuration)
        ? Math.max(1, Math.min(activeMaxDuration, Math.round(authoredDuration)))
        : activeMaxDuration;
      let shot = {
        ...rawShot,
        duration: normalizedDuration,
        clip_duration: normalizedDuration,
      };

      console.log(
        `[ScriptWriter] Shot duration normalized | provider=${IS_AGNES_PROVIDER ? 'agnes' : 'ltx'} ` +
        `requested=${Number.isFinite(authoredDuration) ? authoredDuration : 'missing'} ` +
        `effective=${normalizedDuration}s max=${activeMaxDuration}s`
      );

      const sanitizedShot = _sanitizeDialogueOrActionSemantics({ ...shot });
      const speechEnforced = await _resolveShotSpeechWithRepair(sanitizedShot, scene, characters, {
        sceneNo, shotIndex: Number(sanitizedShot.shot_index || 0),
      });

      if (speechEnforced.speaker_name) {
        console.log(
          `[ScriptWriter] Speech contract locked | S${sceneNo}/idx${Number(speechEnforced.shot_index || 0)} ` +
          `mode=${speechEnforced.tts_mode || 'n/a'} speaker=${speechEnforced.speaker_name} ` +
          `speakers=${(speechEnforced.speakers_in_shot || []).join(',')}`
        );
      }

      if (typeof speechEnforced.image_prompt === 'string') {
        speechEnforced.image_prompt = _sanitizeStillImagePromptText(speechEnforced.image_prompt);
      }

      const normalizedStaging = shotStaging.getShotCharacterStaging(speechEnforced, []);
      speechEnforced.character_staging = normalizedStaging;
      speechEnforced.character_positions = normalizedStaging.length
        ? shotStaging.formatCharacterStagingBlock(normalizedStaging)
        : (speechEnforced.character_positions || '');

      // Re-check after staging normalization so no later transformation can
      // checkpoint a spoken shot with an empty speaker.
      const finalShot = await _resolveShotSpeechWithRepair(speechEnforced, scene, characters, {
        sceneNo, shotIndex: Number(speechEnforced.shot_index || 0),
      });

      // Scene-wide continuity ledger, not just this shot's own fields: the
      // video-generation layer (pipeline.js -> ltxVisionDirector.js /
      // agnesVideoGen.js) reads this off EVERY shot so axis-of-action,
      // wardrobe, and active props stay locked across the whole scene, not
      // only relative to the immediately preceding shot.
      finalShot.scene_continuity_bible = sceneContinuityBible;
      orderedShots.push(finalShot);
    }

    _warnAxisOfActionDrift(sceneNo, orderedShots, sceneContinuityBible);

    const sceneWithShots = { ...scene, shots: orderedShots, continuity_bible: sceneContinuityBible };
    scenesWithShots.push(sceneWithShots);

    if (typeof checkpoint === 'function') {
      await checkpoint({
        sceneNumber: sceneNo,
        completedSceneNumbers: scenesWithShots.map(s => Number(s.scene_number)),
        scenes: scenesWithShots.slice(),
      });
      console.log(`[Pipeline] 💾 Scene-shot checkpoint persisted: scene ${sceneNo}/${totalScenes}`);
    }
  }

  return scenesWithShots;
}


async function writeFinaleAnnouncement(storyline) {
  const systemPrompt = `${DIRECTOR_PERSONA}
You are writing the farewell post for a series that has concluded. Write it with the weight of something real ending.`;

  const userPrompt = `Write a farewell/finale social post for the series "${storyline.title}" (${storyline.genre}) that has just concluded after ${storyline.episode_count} episodes across 4 seasons.

Central theme: ${storyline.central_theme || storyline.plot_summary}

Return JSON:
{
  "post_text": "3-4 sentences. Speak directly to the fans. Acknowledge the journey. End with a reflection question.",
  "hashtags": "#StreamVerseStudios #SeriesFinale and 4-6 genre-specific hashtags"
}`;

  const result = await callLLM(systemPrompt, userPrompt, 512);
  return `${result.post_text || ''}\n\n${result.hashtags || '#StreamVerseStudios'}`;
}

async function writePremiereAnnouncement(storyline) {
  const systemPrompt = `${DIRECTOR_PERSONA}
You are writing the premiere announcement for a new original series. This is the first thing potential fans see.
Make it impossible to scroll past.`;

  const userPrompt = `Write a social/Discord premiere announcement for the new series "${storyline.title}" (${storyline.genre}).

Logline: ${storyline.logline || ''}
Central theme: ${storyline.central_theme || ''}
Engagement hook: ${storyline.engagement_hook || ''}
Premiere announcement copy from the series bible: ${storyline.premiere_announcement || ''}

Return JSON:
{
  "post_text": "3-4 sentences. Open with a statement that stops scrolling. End with the engagement_hook as a direct question.",
  "hashtags": "#StreamVerseStudios #SeriesPremiere #NewShow and 4-6 genre/theme specific hashtags"
}`;

  const result = await callLLM(systemPrompt, userPrompt, 512);
  return `🎬 SERIES PREMIERE\n\n${result.post_text || ''}\n\n${result.hashtags || '#StreamVerseStudios #SeriesPremiere'}`;
}

async function writeShotCaption(storylineTitle, genre, episodeContext) {
  const systemPrompt = `${DIRECTOR_PERSONA}
You write short, visceral social video captions engineered for maximum engagement.`;

  const userPrompt = `Write a social video caption for a ${genre} clip from "${storylineTitle}".
Context: ${episodeContext}

Return: {
  "caption": "Under 60 words. Emotional opener. Engagement tactic. End with a question. 6-8 hashtags.",
  "engagement_tactic": "binary_choice | tag_someone | controversy | poll_question"
}`;

  const result = await callLLM(systemPrompt, userPrompt, 300);
  return result.caption || `✨ ${storylineTitle} | StreamVerse Studios\n\nWatch till the end — would YOU have made the same choice?\n\n#StreamVerseStudios #AIFilm #${genre.replace(/[^a-z0-9]/gi,'')} #NewEpisode`;
}

async function writeAutoCommentReply({ storylineTitle, genre, episodeTitle, commentText }) {
  const systemPrompt = `You are the official community manager for StreamVerse Studios.
You write short, warm, personality-rich replies to viewer comments.
You NEVER reveal you are AI. You write as the voice of the show's production team.
Rules: 1-2 sentences max. Acknowledge what the viewer said. End with a question or teaser.`;

  const userPrompt = `The show: "${storylineTitle}" (${genre})
Current episode: "${episodeTitle}"
Viewer comment: "${commentText}"

Return JSON: { "reply": "1-2 sentence reply." }`;

  try {
    const result = await callLLM(systemPrompt, userPrompt, 200);
    return result.reply || null;
  } catch (err) {
    console.warn('[ScriptWriter] writeAutoCommentReply failed:', err.message);
    return null;
  }
}

async function writeEngagementPost({ storylineTitle, genre, centralTheme, engagementHook, episodeCount }) {
  const systemPrompt = `${DIRECTOR_PERSONA}
You write high-performing social posts designed to re-ignite engagement between episode drops.`;

  const userPrompt = `Write a between-episodes engagement post for "${storylineTitle}" (${genre}).
Central theme: ${centralTheme}
Core engagement hook: ${engagementHook}
Episodes aired so far: ${episodeCount}

Return JSON:
{
  "post_text": "2-3 sentences. Pose a dilemma or ask a fan theory question. Ends with a direct question.",
  "post_type": "fan_theory | character_dilemma | would_you_rather | behind_the_scenes_tease",
  "hashtags": "#StreamVerseStudios #AIFilm and 4-6 relevant tags"
}`;

  try {
    const result = await callLLM(systemPrompt, userPrompt, 400);
    return result.post_text
      ? `${result.post_text}\n\n${result.hashtags || '#StreamVerseStudios'}`
      : null;
  } catch (err) {
    console.warn('[ScriptWriter] writeEngagementPost failed:', err.message);
    return null;
  }
}


/**
 * Director-driven repair for recoverable shot retries.
 *
 * The director receives the last shot object plus the concrete runtime error
 * and returns a semantically complete replacement/patch. This is deliberately
 * provider-agnostic: it can fill missing fields without requiring a source-code
 * edit for every new edge case discovered in production.
 */
function _sanitizeStillImagePromptText(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const blockedSentence = /\b(?:animate|animation|animated|camera\s+(?:moves?|push(?:es|ing)?|pull(?:s|ing)?|pans?|tilts?|cranes?|zooms?|tracks?)|dolly|tracking shot|walking|walks|running|runs|turning|turns|reaching|reaches|approaching|approaches|stepping|steps|moving|moves|movement|speaking|speaks|talking|talks|dialogue|lip[- ]?sync|voice[- ]?over|voiceover|audio|temporal|over time|then begins|continues to)\b/i;
  return raw
    .split(/(?<=[.!?])\s+|\n+/)
    .map(sentence => sentence.trim())
    .filter(Boolean)
    .filter(sentence => !blockedSentence.test(sentence))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function repairShotForRetry({ shot, storyline, previousShot = null, error = '', failedPrompt = null, attempt = 1, maxRetries = 3 }) {
  const safeShot = shot && typeof shot === 'object' ? shot : {};
  const systemPrompt = `${DIRECTOR_PERSONA}

RETRY REPAIR MODE:
You are repairing one production shot after a runtime failure. Do not merely repeat the
same shot. Diagnose the missing, malformed, or inconsistent field and return a complete,
provider-safe shot patch.

SEMANTIC CONTRACT:
- "..." quotation marks are ONLY for exact words actually spoken aloud.
- Actions, emotions, facial expressions, internal states, camera behavior, environmental
  events, temporal arcs, and end-frame transitions are plain descriptive prose and NEVER quoted.
- image_prompt is a frozen STILL IMAGE description only. Never describe movement, speaking,
  lip movement, camera motion, audio, or instructions to an image model in image_prompt.
- temporal_arc, subject_motion, environmental_story_beat, end_frame_transition and
  next_shot_continuity describe what happens over time and are never quoted.
- duration must respect the active provider contract: Agnes may use 1-18 seconds (18s maximum),
  while LTX remains capped at 10 seconds. Do not impose an LTX duration rule on Agnes.
- Keep one speaking character per shot.
- Preserve character names and story continuity unless the error itself indicates a field is invalid.
- The movie should remain engaging and strongly dialogue-forward when the scene naturally supports speech.
- Build the LTX-ready semantics in this order: visible world/start state, progression, visible emotion,
  camera, spoken dialogue, meaningful end state, natural ambience, and optional music only when truly needed.
- Default music_cue to "none"; never add background music merely because the episode has a score palette.
- Use music only when the story context genuinely benefits from it.
`;

  const userPrompt = `Repair this failed StreamVerse shot for retry ${attempt}/${maxRetries}.

RUNTIME ERROR:
${String(error).slice(0, 1200)}

FAILED IMAGE PROMPT (may be null):
${failedPrompt || '(none)'}

PREVIOUS SHOT CONTEXT:
${previousShot ? JSON.stringify(previousShot).slice(0, 6000) : '(none)'}

CURRENT SHOT:
${JSON.stringify(safeShot).slice(0, 12000)}

STORYLINE:
Title: ${storyline?.title || ''}
Genre: ${storyline?.genre || ''}
Theme: ${storyline?.central_theme || ''}
Tone: ${storyline?.tone_manifesto || ''}

Return JSON ONLY. Return a PATCH containing every field that is missing, malformed,
or should change to make the shot safely retryable. Preserve valid existing values.

{
  "image_prompt": "A vivid frozen-frame description for the still-image model only.",
  "dialogue_or_action": "Plain descriptive action, OR spoken dialogue with quoted spoken words, OR NAME (V.O.): unquoted internal voice-over thought.",
  "tts_mode": "spoken | ambient | phone_vo | internal_monologue",
  "speaker": "REQUIRED exact named cast member for spoken, phone_vo, or internal_monologue; empty ONLY for ambient/action-only shots.",
  "speaker_name": "Same required named speaker as speaker.",
  "speakers_in_shot": ["Every named speaker in chronological order for multi-turn dialogue."],
  "duration": ${_SCRIPT_MAX_DURATION},
  "temporal_arc": "A complete visual micro-arc from beginning state through development to end state.",
  "environmental_story_beat": "A concrete environmental event that matters to the scene.",
  "music_cue": "none | subtle | prominent",
  "music_reason": "Why music is genuinely needed, or empty when music_cue is none.",
  "end_frame_transition": "The descriptive final visual/audio state reached by this shot. Physically rendered as the bridge into the next shot's opening keyframe (~3-4s window) — as important as the shot's own content.",
  "next_shot_continuity": "The descriptive fact the next shot should inherit. This is the physical continuity anchor the next shot's video generation is conditioned on.",
  "subject_motion": "Observable movement over time, unquoted.",
  "camera_movement": "Descriptive camera behavior, unquoted.",
  "narrative_complexity": "low | medium | high"
}

Do not add keys outside this patch schema.`;

  const repaired = await callLLM(
    `${systemPrompt}\n${MULTI_SPEAKER_LTX_RULES}`,
    userPrompt,
    1400,
    { useStream: false, temperature: 0.20 }
  );

  if (!repaired || typeof repaired !== 'object') {
    throw new Error('Director returned no repair object');
  }

  const out = { ...repaired };
  // Apply the same semantic dialogue hygiene used in normal shot generation.
  const sanitized = _sanitizeDialogueOrActionSemantics(out);

  // Normalize duration defensively against the ACTIVE provider contract.
  // Agnes: max 18s. LTX: max 10s.
  const requestedDuration = Number(sanitized.duration);
  const providerMaxDuration = IS_AGNES_PROVIDER ? 18 : 10;
  const providerMinDuration = 1;
  sanitized.duration = Number.isFinite(requestedDuration)
    ? Math.max(providerMinDuration, Math.min(providerMaxDuration, Math.round(requestedDuration)))
    : _SCRIPT_MAX_DURATION;

  // Never let retry repair reintroduce video/temporal language into the still prompt.
  if (typeof sanitized.image_prompt === 'string') {
    sanitized.image_prompt = _sanitizeStillImagePromptText(sanitized.image_prompt);
  }

  const speechRepair = _enforceShotSpeechMetadata(
    sanitized,
    null,
    [],
    { hardFail: false }
  );

  if (!speechRepair.valid) {
    throw new Error(`[ScriptWriter] Retry repair produced an LTX-unsafe speech shot: ${speechRepair.reason}`);
  }

  return speechRepair.shot;
}

module.exports = {
  callLLM,
  writeSeriesSummary,
  simulateSeriesStory,
  simulateEpisodeTrajectoryWindow,
  simulateEpisodeStory,
  simulateEpisodeShots,
  writeCastBible,
  writeNewStoryline: writeSeriesSummary,  // backward-compatible alias
  writeEpisodeScript,
  generateCharacterVisualAnchor,
  rewriteCharacterPortraitPrompt,
  writeFinaleAnnouncement,
  writePremiereAnnouncement,
  writeShotCaption,
  writeAutoCommentReply,
  writeEngagementPost,
  repairShotForRetry,
  ensureSceneSpeechCoverage,
  _canonicalCharacterName,
  _extractQuotedSpeakerLabels,
  _inferShotSpeakers,
  _enforceShotSpeechMetadata,
  _validateShotSimulationSpeech,
  _resolveShotSpeakerWithRepair,
  _resolveShotSpeechWithRepair,
  _compactSceneBeatPlan,
  _normalizeSeasonEndpoints,
  _serializeRepairPayload,
  _applySceneSpeechRepairPatch,
  _validatePersistedSceneShots,
  assignVoiceForCharacter,
  assignSeedForCharacter,
  assignShotSeed,
  isAgnesProvider: () => IS_AGNES_PROVIDER,
  travelContinuityRules: TRAVEL_CONTINUITY_RULES,
  agnesConversationalRules: AGNES_CONVERSATIONAL_RULES,
  applyDirectorialIntelligence: directorialOrchestrator.applyToScript,
  applyDirectorialShotSimulation: directorialOrchestrator.applyToShotSimulation,
};