import io
import os
import urllib.parse
from datetime import datetime, timezone

import boto3
from PIL import Image

s3 = boto3.client("s3")
ddb = boto3.client("dynamodb")

BUCKET = os.environ["BUCKET_NAME"]
TABLE = os.environ["PHOTOS_TABLE"]

SIZES = {"thumb": 400, "medium": 1200, "large": 2400}


def parse_photo_id_and_filename(key: str) -> tuple[str, str]:
    # key is originals/{photo_id}/{filename}
    parts = key.split("/", 2)
    if len(parts) != 3 or parts[0] != "originals":
        raise ValueError(f"unexpected key shape: {key}")
    return parts[1], parts[2]


def resize_to_webp(data: bytes, max_width: int) -> bytes:
    img = Image.open(io.BytesIO(data))
    img = img.convert("RGB")
    if img.width > max_width:
        h = int(img.height * (max_width / img.width))
        img = img.resize((max_width, h), Image.LANCZOS)
    buf = io.BytesIO()
    # exif explicitly NOT passed → stripped
    img.save(buf, format="WEBP", quality=85, method=6)
    return buf.getvalue()


def handler(event, _ctx):
    record = event["Records"][0]
    bucket = record["s3"]["bucket"]["name"]
    key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])

    head = s3.head_object(Bucket=bucket, Key=key)
    metadata = head.get("Metadata", {})
    title = metadata.get("title", "")
    is_public = metadata.get("is-public", "false").lower() == "true"

    photo_id, filename = parse_photo_id_and_filename(key)
    obj = s3.get_object(Bucket=bucket, Key=key)
    body = obj["Body"].read()

    orig_img = Image.open(io.BytesIO(body))
    orig_w, orig_h = orig_img.width, orig_img.height

    variants = {}
    for label, width in SIZES.items():
        out_key = f"processed/{photo_id}/{label}.webp"
        s3.put_object(
            Bucket=bucket,
            Key=out_key,
            Body=resize_to_webp(body, width),
            ContentType="image/webp",
            CacheControl="public, max-age=31536000, immutable",
        )
        variants[label] = {"S": out_key}

    ddb.put_item(
        TableName=TABLE,
        Item={
            "photo_id": {"S": photo_id},
            "title": {"S": title},
            "original_filename": {"S": filename},
            "original_key": {"S": key},
            "is_public": {"BOOL": is_public},
            "is_public_str": {"S": "true" if is_public else "false"},
            "created_at": {"S": datetime.now(timezone.utc).isoformat()},
            "variants": {"M": variants},
            "width": {"N": str(orig_w)},
            "height": {"N": str(orig_h)},
        },
    )
    return {"ok": True}
