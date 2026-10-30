import os
import subprocess
import sys

REPO_URL = "https://github.com/hexon-dev/StreamVerse.git"
COMMIT_MESSAGE = "Transfer complete StreamVerse project from Replit"


def run(command, check=True):
    print(f"\n>>> {' '.join(command)}")
    result = subprocess.run(command, text=True, capture_output=True)

    if result.stdout:
        print(result.stdout)
    if result.stderr:
        print(result.stderr)

    if check and result.returncode != 0:
        raise RuntimeError(
            f"Command failed (exit {result.returncode}): {' '.join(command)}"
        )
    return result


def main():
    root = os.getcwd()
    print("=" * 58)
    print("STREAMVERSE GITHUB TRANSFER")
    print("=" * 58)
    print(f"Project directory: {root}")
    print(f"Destination: {REPO_URL}")

    run(["git", "--version"])

    git_dir = os.path.join(root, ".git")
    if not os.path.isdir(git_dir):
        print("\nInitializing Git repository...")
        run(["git", "init"])

    # Use the repository-local exclude file so existing project files
    # (including .gitignore and .env) are not edited.
    exclude_file = os.path.join(git_dir, "info", "exclude")
    os.makedirs(os.path.dirname(exclude_file), exist_ok=True)

    protected = [
        ".env",
        ".env.*",
        "*.pem",
        "*.key",
        "id_rsa",
        "id_ed25519",
        "credentials.json",
        "secrets.json",
        "node_modules/",
        ".next/",
        "dist/",
        "build/",
        "__pycache__/",
    ]

    try:
        with open(exclude_file, "r", encoding="utf-8") as f:
            existing_lines = set(f.read().splitlines())
    except FileNotFoundError:
        existing_lines = set()

    with open(exclude_file, "a", encoding="utf-8") as f:
        for pattern in protected:
            if pattern not in existing_lines:
                f.write(pattern + "\n")

    print("\nProtected local secrets and generated directories from new staging.")

    remote = run(["git", "remote", "get-url", "origin"], check=False)
    if remote.returncode == 0:
        run(["git", "remote", "set-url", "origin", REPO_URL])
    else:
        run(["git", "remote", "add", "origin", REPO_URL])

    print("\nChecking for already-staged sensitive files...")
    staged = run(["git", "diff", "--cached", "--name-only"]).stdout.splitlines()
    sensitive_names = {
        ".env",
        "credentials.json",
        "secrets.json",
        "id_rsa",
        "id_ed25519",
    }
    risky = [
        name for name in staged
        if os.path.basename(name) in sensitive_names
        or name.endswith((".pem", ".key"))
        or os.path.basename(name).startswith(".env.")
    ]
    if risky:
        print("STOP: sensitive files are already staged:")
        for name in risky:
            print(f"  - {name}")
        print("Unstage/review these files before running the transfer again.")
        sys.exit(2)

    print("\nStaging project files...")
    run(["git", "add", "-A"])

    # Recheck staged paths after adding, to avoid pushing common secrets.
    staged = run(["git", "diff", "--cached", "--name-only"]).stdout.splitlines()
    risky = [
        name for name in staged
        if os.path.basename(name) in sensitive_names
        or name.endswith((".pem", ".key"))
        or os.path.basename(name).startswith(".env.")
    ]
    if risky:
        run(["git", "reset", "--", *risky], check=False)
        print("STOP: possible secret files were detected and unstaged:")
        for name in risky:
            print(f"  - {name}")
        print("Review these files manually; nothing has been pushed.")
        sys.exit(2)

    staged_diff = run(["git", "diff", "--cached", "--quiet"], check=False)
    if staged_diff.returncode == 0:
        print("\nNo new changes to commit.")
    else:
        print("\nCreating commit...")
        run(["git", "commit", "-m", COMMIT_MESSAGE])

    branch = run(["git", "branch", "--show-current"]).stdout.strip()
    if not branch:
        branch = "main"
        run(["git", "checkout", "-B", branch])

    print("\nPushing to GitHub (no force-push)...")
    push = run(["git", "push", "-u", "origin", branch], check=False)
    if push.returncode != 0:
        print("\nPUSH FAILED. No force-push was attempted.")
        print("Check Replit GitHub authentication and remote branch conflicts.")
        sys.exit(1)

    commit = run(["git", "rev-parse", "HEAD"]).stdout.strip()
    print("\n" + "=" * 58)
    print("TRANSFER SUCCESSFUL")
    print("=" * 58)
    print(f"Repository: {REPO_URL}")
    print(f"Branch: {branch}")
    print(f"Commit: {commit}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"\nTRANSFER ERROR: {exc}")
        sys.exit(1)
