from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_DIR = ROOT / "public"
DATA_FILE = ROOT / "data" / "photos.json"
PUBLIC_MANIFEST = PUBLIC_DIR / "photos.json"
DISPLAY_DIR = PUBLIC_DIR / "display"
MOBILE_DIR = PUBLIC_DIR / "mobile"

VARIANTS = (
    ("displaySrc", DISPLAY_DIR, "display", 1600, 78),
    ("mobileSrc", MOBILE_DIR, "mobile", 900, 72),
)


def main() -> None:
    photos = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    if not isinstance(photos, list):
        raise ValueError("data/photos.json must contain a list of photos.")

    DISPLAY_DIR.mkdir(parents=True, exist_ok=True)
    MOBILE_DIR.mkdir(parents=True, exist_ok=True)

    for index, photo in enumerate(photos, 1):
        source_path = resolve_public_path(photo.get("src"))
        if not source_path or not source_path.exists():
            print(f"skip missing source: {photo.get('src')}")
            continue

        output_name = f"{source_path.stem}.jpg"
        with Image.open(source_path) as image:
            image = ImageOps.exif_transpose(image)
            image = flatten_to_rgb(image)

            for key, directory, public_folder, max_size, quality in VARIANTS:
                output_path = directory / output_name
                resized = image.copy()
                resized.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
                resized.save(
                    output_path,
                    "JPEG",
                    quality=quality,
                    optimize=True,
                    progressive=True,
                )
                photo[key] = f"/{public_folder}/{output_name}"

        print(f"{index:02d}/{len(photos)} optimized {source_path.name}")

    DATA_FILE.write_text(f"{json.dumps(photos, indent=2, ensure_ascii=False)}\n", encoding="utf-8")
    PUBLIC_MANIFEST.write_text(
        f"{json.dumps(make_public_manifest(photos), indent=2, ensure_ascii=False)}\n",
        encoding="utf-8",
    )


def resolve_public_path(src: object) -> Path | None:
    if not isinstance(src, str) or src.startswith(("http://", "https://", "data:", "blob:")):
        return None

    relative = src.lstrip("/")
    candidate = (PUBLIC_DIR / relative).resolve()

    try:
        candidate.relative_to(PUBLIC_DIR.resolve())
    except ValueError:
        return None

    return candidate


def flatten_to_rgb(image: Image.Image) -> Image.Image:
    if image.mode == "RGB":
        return image

    if image.mode in {"RGBA", "LA"} or (image.mode == "P" and "transparency" in image.info):
        alpha_image = image.convert("RGBA")
        background = Image.new("RGBA", alpha_image.size, (244, 244, 242, 255))
        background.alpha_composite(alpha_image)
        return background.convert("RGB")

    return image.convert("RGB")


def make_public_manifest(photos: list[dict]) -> dict:
    return {
        "photos": [
            {
                **photo,
                "src": strip_leading_slash(photo.get("src")),
                "displaySrc": strip_leading_slash(photo.get("displaySrc")),
                "mobileSrc": strip_leading_slash(photo.get("mobileSrc")),
            }
            for photo in photos
        ],
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def strip_leading_slash(value: object) -> object:
    return value.lstrip("/") if isinstance(value, str) else value


if __name__ == "__main__":
    main()
