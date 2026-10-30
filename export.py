import os
from pathlib import Path
from datetime import datetime

# ==================================================
# CONFIGURATION
# ==================================================

PROJECT_ROOT = Path(__file__).resolve().parent
OUTPUT_FILE = PROJECT_ROOT / "FULL_PROJECT_EXPORT.txt"

EXCLUDED_DIRS = {
    "node_modules",
    ".git",
    ".next",
    ".turbo",
    ".vercel",
    "dist",
    "build",
    "out",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
    ".cache",
    ".idea",
    ".pytest_cache",
    "vendor",
}

EXCLUDED_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp",
    ".ico", ".mp4", ".mov", ".mp3", ".wav",
    ".pdf", ".zip", ".rar", ".7z",
    ".exe", ".dll", ".so", ".bin",
    ".db", ".sqlite", ".sqlite3",
    ".woff", ".woff2", ".ttf", ".otf",
    ".wasm", ".pyc", ".class",
}

EXCLUDED_FILES = {
    "FULL_PROJECT_EXPORT.txt",
    "export_project.py",
    ".DS_Store",
    "Thumbs.db",
}


# ==================================================
# FILE DISCOVERY
# ==================================================

def collect_files(root: Path) -> list[Path]:
    collected = []

    for current_root, directories, filenames in os.walk(root):
        directories[:] = sorted(
            directory
            for directory in directories
            if directory not in EXCLUDED_DIRS
        )

        for filename in sorted(filenames):
            if filename in EXCLUDED_FILES:
                continue

            file_path = Path(current_root) / filename

            if file_path.suffix.lower() in EXCLUDED_EXTENSIONS:
                continue

            if not file_path.is_file():
                continue

            collected.append(file_path)

    return sorted(collected)


# ==================================================
# DIRECTORY TREE
# ==================================================

def generate_tree(root: Path) -> str:
    lines = [f"{root.name}/"]

    def walk(directory: Path, prefix: str = "") -> None:
        entries = sorted(
            (
                item for item in directory.iterdir()
                if item.name not in EXCLUDED_DIRS
                and item.name not in EXCLUDED_FILES
            ),
            key=lambda item: (item.is_file(), item.name.lower()),
        )

        for index, item in enumerate(entries):
            is_last = index == len(entries) - 1

            connector = "└── " if is_last else "├── "
            suffix = "/" if item.is_dir() else ""

            lines.append(f"{prefix}{connector}{item.name}{suffix}")

            if item.is_dir():
                extension = "    " if is_last else "│   "
                walk(item, prefix + extension)

    walk(root)
    return "\n".join(lines)


# ==================================================
# FILE READING
# ==================================================

def read_file(file_path: Path) -> str:
    try:
        return file_path.read_text(
            encoding="utf-8",
            errors="replace",
        )
    except OSError as error:
        return f"[ERROR READING FILE: {error}]"


# ==================================================
# PROJECT EXPORT
# ==================================================

def export_project() -> None:
    files = collect_files(PROJECT_ROOT)

    print(f"Project: {PROJECT_ROOT}")
    print(f"Files discovered: {len(files)}")

    with OUTPUT_FILE.open(
        "w",
        encoding="utf-8",
        newline="\n",
    ) as output:

        # PROJECT INFORMATION

        output.write("=" * 100 + "\n")
        output.write("COMPLETE PROJECT SOURCE EXPORT\n")
        output.write("=" * 100 + "\n\n")

        output.write(f"Project: {PROJECT_ROOT.name}\n")
        output.write(f"Root: {PROJECT_ROOT}\n")
        output.write(f"Export date: {datetime.now().isoformat()}\n")
        output.write(f"Total files: {len(files)}\n")

        # SECTION 1: DIRECTORY TREE

        output.write("\n\n")
        output.write("=" * 100 + "\n")
        output.write("SECTION 1: COMPLETE PROJECT DIRECTORY TREE\n")
        output.write("=" * 100 + "\n\n")

        output.write(generate_tree(PROJECT_ROOT))

        # SECTION 2: FILE CONTENTS

        output.write("\n\n")
        output.write("=" * 100 + "\n")
        output.write("SECTION 2: COMPLETE PROJECT FILE CONTENTS\n")
        output.write("=" * 100 + "\n")

        for index, file_path in enumerate(files, start=1):
            relative_path = file_path.relative_to(PROJECT_ROOT)
            content = read_file(file_path)

            output.write("\n\n")
            output.write("#" * 100 + "\n")
            output.write(f"FILE {index} OF {len(files)}\n")
            output.write(f"PATH: {relative_path}\n")
            output.write(f"SIZE: {file_path.stat().st_size} bytes\n")
            output.write("#" * 100 + "\n\n")

            output.write(content)
            output.write("\n\n")

            print(
                f"[{index}/{len(files)}] {relative_path}"
            )

        # EXPORT FOOTER

        output.write("\n")
        output.write("=" * 100 + "\n")
        output.write("PROJECT EXPORT COMPLETED\n")
        output.write(f"TOTAL FILES: {len(files)}\n")
        output.write("=" * 100 + "\n")

    print("\nEXPORT COMPLETED SUCCESSFULLY")
    print(f"Files exported: {len(files)}")
    print(f"Output: {OUTPUT_FILE}")


# ==================================================
# ENTRY POINT
# ==================================================

if __name__ == "__main__":
    export_project()