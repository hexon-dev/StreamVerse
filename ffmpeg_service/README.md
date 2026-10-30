# External FFmpeg service

This directory contains the external FFmpeg microservice used by StreamVerse. It is deployed separately from the main StreamVerse application. Including this directory in a StreamVerse ZIP does not update an already-hosted FFmpeg service.

## Required environment

- `FFMPEG_SERVICE_API_KEY` (or legacy `API_KEY` / `FFMPEG_API_KEY`) — must match StreamVerse's FFmpeg secret.
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

The HTTP authentication contract remains `x-api-key`. `/health` is public; `/effects`, `/diagnostics`, `/compose`, `/merge`, `/status/:id`, and `/frames` require the FFmpeg service API key.

`/diagnostics` reports only whether credential fields are configured; it never returns secret values.

## Diagnosing HTTP 401 job failures

When StreamVerse says `FFmpeg job <id> failed: Request failed with status code 401`, the FFmpeg service has already accepted `/compose` or `/merge` and created the job. The 401 is therefore an internal job operation, not the external FFmpeg API authentication. This version labels the failing step as `downloading` or `uploading` and distinguishes source-download 401s from Cloudinary 401s.
