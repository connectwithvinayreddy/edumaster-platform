from __future__ import annotations

import math
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = ROOT / "play-store-assets"
SOURCE_SCREENSHOTS = [
    (
        ROOT
        / "qa-automation/artifacts/2026-05-21T15-17-48-032Z/screenshots/overview-mobile-mobile.png",
        "Learn Smarter Every Day",
        "Track progress, continue lessons, and stay exam-ready from one clean dashboard.",
        "phone-screenshot-01-overview.png",
    ),
    (
        ROOT
        / "qa-automation/artifacts/2026-05-21T10-12-26-497Z/screenshots/course-page-mobile-course-page-mobile.png",
        "Structured Course Experience",
        "Move through lessons, topics, and revision paths with a focused learning flow.",
        "phone-screenshot-02-course.png",
    ),
    (
        ROOT
        / "qa-automation/artifacts/2026-05-21T10-12-26-497Z/screenshots/course-lesson-mobile-video-course-lesson-mobile-video.png",
        "Watch Classes On Mobile",
        "Study with lesson video, notes, progress, and next steps in one place.",
        "phone-screenshot-03-video.png",
    ),
    (
        ROOT
        / "qa-automation/artifacts/2026-05-21T15-17-48-032Z/screenshots/mocktests-mobile-mobile.png",
        "Practice With Mock Tests",
        "Build confidence with test-style practice and exam-focused revision support.",
        "phone-screenshot-04-mock-tests.png",
    ),
]

LOGO_PATH = ROOT / "public/varonenglish-logo.png"
ICON_PATH = ROOT / "public/icons/icon-512.png"


def load_font(size: int, weight: str = "regular") -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = []
    if weight == "bold":
        candidates = [
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/System/Library/Fonts/Supplemental/Helvetica Bold.ttf",
            "/Library/Fonts/Arial Bold.ttf",
        ]
    else:
        candidates = [
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/System/Library/Fonts/Supplemental/Helvetica.ttf",
            "/Library/Fonts/Arial.ttf",
        ]

    for candidate in candidates:
        path = Path(candidate)
        if path.exists():
            return ImageFont.truetype(str(path), size=size)
    return ImageFont.load_default()


def make_vertical_gradient(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    width, height = size
    image = Image.new("RGB", size, top)
    draw = ImageDraw.Draw(image)
    for y in range(height):
        ratio = y / max(1, height - 1)
        color = tuple(int(top[i] * (1 - ratio) + bottom[i] * ratio) for i in range(3))
        draw.line((0, y, width, y), fill=color)
    return image


def add_soft_glow(base: Image.Image, center: tuple[int, int], radius: int, color: tuple[int, int, int, int]) -> None:
    glow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(glow)
    x, y = center
    draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)
    glow = glow.filter(ImageFilter.GaussianBlur(radius // 2))
    base.alpha_composite(glow)


def fit_image(img: Image.Image, box: tuple[int, int], mode: str = "contain") -> Image.Image:
    target_w, target_h = box
    src_w, src_h = img.size
    if mode == "cover":
        scale = max(target_w / src_w, target_h / src_h)
    else:
        scale = min(target_w / src_w, target_h / src_h)
    resized = img.resize((max(1, int(src_w * scale)), max(1, int(src_h * scale))), Image.Resampling.LANCZOS)
    if mode == "cover":
        left = max(0, (resized.width - target_w) // 2)
        top = max(0, (resized.height - target_h) // 2)
        resized = resized.crop((left, top, left + target_w, top + target_h))
    return resized


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size[0], size[1]), radius=radius, fill=255)
    return mask


def draw_wrapped_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    fill: tuple[int, int, int],
    x: int,
    y: int,
    max_width: int,
    line_gap: int,
) -> int:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = word if not current else f"{current} {word}"
        bbox = draw.textbbox((0, 0), candidate, font=font)
        if bbox[2] - bbox[0] <= max_width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)

    current_y = y
    for line in lines:
        draw.text((x, current_y), line, font=font, fill=fill)
        bbox = draw.textbbox((x, current_y), line, font=font)
        current_y += (bbox[3] - bbox[1]) + line_gap
    return current_y


def generate_feature_graphic() -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    canvas = make_vertical_gradient((1024, 500), (10, 20, 44), (26, 54, 112)).convert("RGBA")

    add_soft_glow(canvas, (190, 100), 140, (19, 103, 255, 120))
    add_soft_glow(canvas, (880, 120), 150, (255, 191, 0, 90))
    add_soft_glow(canvas, (760, 420), 180, (45, 110, 229, 80))

    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    o = ImageDraw.Draw(overlay)
    o.rounded_rectangle((40, 36, 984, 464), radius=36, fill=(255, 255, 255, 12), outline=(255, 255, 255, 24), width=2)
    for offset in range(0, 1024, 140):
        o.line((offset, 0, offset + 260, 500), fill=(255, 255, 255, 15), width=2)
    canvas.alpha_composite(overlay)

    logo = Image.open(LOGO_PATH).convert("RGBA")
    logo = fit_image(logo, (390, 390), mode="contain")
    canvas.alpha_composite(logo, (70, 60))

    draw = ImageDraw.Draw(canvas)
    eyebrow_font = load_font(28, "bold")
    title_font = load_font(56, "bold")
    body_font = load_font(25, "regular")

    draw.text((460, 92), "VARONENGLISH", font=eyebrow_font, fill=(255, 209, 72))
    draw.text((460, 136), "English Prep", font=title_font, fill=(255, 255, 255))
    draw.text((460, 202), "For Competitive Exams", font=title_font, fill=(154, 197, 255))

    draw_wrapped_text(
        draw,
        "Live classes, structured lessons, mock tests, and progress tracking for serious learners.",
        body_font,
        (231, 240, 255),
        462,
        296,
        470,
        10,
    )

    cta_box = (462, 390, 792, 448)
    draw.rounded_rectangle(cta_box, radius=18, fill=(255, 199, 0), outline=None)
    cta_font = load_font(28, "bold")
    cta_text = "Learn Anywhere on Mobile"
    bbox = draw.textbbox((0, 0), cta_text, font=cta_font)
    draw.text(
        (cta_box[0] + ((cta_box[2] - cta_box[0]) - (bbox[2] - bbox[0])) // 2, cta_box[1] + 12),
        cta_text,
        font=cta_font,
        fill=(28, 31, 41),
    )

    out_path = OUTPUT_DIR / "feature-graphic-1024x500.png"
    canvas.convert("RGB").save(out_path, quality=95)
    return out_path


def generate_phone_screenshot(src_path: Path, title: str, body: str, filename: str) -> Path:
    canvas = make_vertical_gradient((1080, 1920), (246, 248, 255), (228, 238, 255)).convert("RGBA")
    add_soft_glow(canvas, (160, 220), 170, (49, 108, 255, 90))
    add_soft_glow(canvas, (920, 260), 180, (255, 196, 0, 85))
    add_soft_glow(canvas, (840, 1480), 220, (43, 92, 214, 65))

    draw = ImageDraw.Draw(canvas)
    badge_font = load_font(34, "bold")
    title_font = load_font(72, "bold")
    body_font = load_font(34, "regular")

    draw.rounded_rectangle((72, 70, 414, 136), radius=24, fill=(20, 45, 96))
    draw.text((102, 88), "VARONENGLISH", font=badge_font, fill=(255, 210, 74))

    current_y = 190
    current_y = draw_wrapped_text(draw, title, title_font, (24, 39, 71), 72, current_y, 680, 8)
    draw_wrapped_text(draw, body, body_font, (72, 88, 122), 72, current_y + 18, 620, 10)

    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    phone_box = (160, 430, 920, 1760)
    sdraw.rounded_rectangle(phone_box, radius=72, fill=(23, 37, 68, 75))
    shadow = shadow.filter(ImageFilter.GaussianBlur(24))
    canvas.alpha_composite(shadow, (0, 22))

    frame = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    fdraw = ImageDraw.Draw(frame)
    fdraw.rounded_rectangle(phone_box, radius=72, fill=(20, 29, 48), outline=(255, 255, 255, 26), width=3)

    screen_box = (190, 470, 890, 1718)
    screen_size = (screen_box[2] - screen_box[0], screen_box[3] - screen_box[1])
    source = Image.open(src_path).convert("RGBA")
    screen = fit_image(source, screen_size, mode="cover")
    mask = rounded_mask(screen_size, 42)

    screen_layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    screen_layer.paste(screen, (screen_box[0], screen_box[1]), mask)

    notch_w = 220
    notch_h = 36
    notch_x = (phone_box[0] + phone_box[2] - notch_w) // 2
    notch_y = screen_box[1] + 18
    fdraw.rounded_rectangle((notch_x, notch_y, notch_x + notch_w, notch_y + notch_h), radius=18, fill=(15, 23, 38))

    canvas.alpha_composite(frame)
    canvas.alpha_composite(screen_layer)

    out_path = OUTPUT_DIR / filename
    canvas.convert("RGB").save(out_path, quality=95)
    return out_path


def ensure_app_icon() -> Path:
    out_path = OUTPUT_DIR / "app-icon-512.png"
    shutil.copy2(ICON_PATH, out_path)
    return out_path


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    outputs = [ensure_app_icon(), generate_feature_graphic()]
    for src_path, title, body, filename in SOURCE_SCREENSHOTS:
        outputs.append(generate_phone_screenshot(src_path, title, body, filename))

    print("Generated Play Store assets:")
    for output in outputs:
        print(output.relative_to(ROOT))


if __name__ == "__main__":
    main()
