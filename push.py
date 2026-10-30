import subprocess
import sys

REMOTE = "origin"
BRANCH = "main"


def run(args, check=True):
    print("\n>>> " + " ".join(args))
    result = subprocess.run(args, text=True, capture_output=True)

    if result.stdout:
        print(result.stdout)
    if result.stderr:
        print(result.stderr)

    if check and result.returncode != 0:
        raise RuntimeError(
            f"Command failed (exit {result.returncode}): {' '.join(args)}"
        )
    return result


def main():
    print("=" * 60)
    print("STREAMVERSE: SAFE GITHUB HISTORY SYNC")
    print("=" * 60)

    # Do not merge over uncommitted edits.
    status = run(["git", "status", "--porcelain"]).stdout.strip()
    if status:
        print("\nSTOP: Your working tree has uncommitted changes.")
        print("Commit or safely stash them before running this sync script.")
        sys.exit(2)

    current_branch = run(["git", "branch", "--show-current"]).stdout.strip()
    if current_branch != BRANCH:
        print(f"\nSTOP: Expected branch '{BRANCH}', found '{current_branch}'.")
        print("Switch to the correct branch before running this script.")
        sys.exit(2)

    remote_url = run(["git", "remote", "get-url", REMOTE]).stdout.strip()
    print(f"\nRemote: {remote_url}")
    print(f"Branch: {BRANCH}")

    print("\nFetching the existing GitHub history...")
    run(["git", "fetch", REMOTE])

    remote_ref = f"{REMOTE}/{BRANCH}"
    exists = run(
        ["git", "rev-parse", "--verify", remote_ref],
        check=False
    )
    if exists.returncode != 0:
        print(f"\nSTOP: Remote branch {remote_ref} was not found.")
        print("Check the repository and branch name.")
        sys.exit(2)

    # Merge, rather than rebase or force-push, to preserve both histories.
    print("\nIntegrating GitHub's existing main branch...")
    merge = run(
        [
            "git", "merge",
            "--no-edit",
            "--allow-unrelated-histories",
            remote_ref,
        ],
        check=False,
    )

    if merge.returncode != 0:
        print("\nMERGE NEEDS ATTENTION.")
        print("Git could not integrate the histories automatically.")
        print("No force-push was performed and no remote history was overwritten.")
        print("The repository may now contain merge conflicts.")
        print("Resolve the conflicts in Replit's editor, then commit the merge")
        print("and run this script again.")
        sys.exit(1)

    print("\nPushing the integrated history to GitHub...")
    push = run(
        ["git", "push", "-u", REMOTE, BRANCH],
        check=False
    )

    if push.returncode != 0:
        print("\nPUSH FAILED. No force-push was attempted.")
        print("Fetch and inspect the new remote changes before trying again.")
        sys.exit(1)

    commit = run(["git", "rev-parse", "HEAD"]).stdout.strip()
    print("\n" + "=" * 60)
    print("SYNC AND PUSH SUCCESSFUL")
    print("=" * 60)
    print(f"Repository: {remote_url}")
    print(f"Branch: {BRANCH}")
    print(f"Integrated commit: {commit}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"\nERROR: {exc}")
        sys.exit(1)
