import json
import os
import uuid
from typing import Any

import boto3

s3 = boto3.client("s3")
ddb = boto3.resource("dynamodb")
PHOTOS = ddb.Table(os.environ["PHOTOS_TABLE"])
USERS = ddb.Table(os.environ["USERS_TABLE"])
BUCKET = os.environ["BUCKET_NAME"]

ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_BYTES = 50 * 1024 * 1024


def respond(status: int, body: Any) -> dict:
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def get_role(email: str) -> str | None:
    item = USERS.get_item(Key={"email": email.lower()}).get("Item")
    return item.get("role") if item else None


def require_admin(event) -> str | None:
    """Returns email if admin, else None (caller must short-circuit)."""
    claims = (event.get("requestContext", {})
              .get("authorizer", {})
              .get("claims") or {})
    email = claims.get("email")
    if not email:
        return None
    return email if get_role(email) == "admin" else None


def presign(event):
    body = json.loads(event["body"] or "{}")
    filename = body.get("filename")
    content_type = body.get("contentType")
    title = body.get("title", "")
    is_public = bool(body.get("isPublic", False))

    if content_type not in ALLOWED_TYPES:
        return respond(400, {"error": "unsupported_content_type"})
    if not filename:
        return respond(400, {"error": "filename_required"})

    photo_id = str(uuid.uuid4())
    key = f"originals/{photo_id}/{filename}"
    is_public_str = "true" if is_public else "false"

    presigned = s3.generate_presigned_post(
        Bucket=BUCKET,
        Key=key,
        Fields={
            "Content-Type": content_type,
            "x-amz-meta-title": title,
            "x-amz-meta-is-public": is_public_str,
        },
        Conditions=[
            {"bucket": BUCKET},
            {"key": key},
            {"Content-Type": content_type},
            {"x-amz-meta-title": title},
            {"x-amz-meta-is-public": is_public_str},
            ["content-length-range", 0, MAX_BYTES],
        ],
        ExpiresIn=300,
    )
    return respond(200, {
        "url": presigned["url"],
        "fields": presigned["fields"],
        "photoId": photo_id,
    })


def delete_photo(event):
    body = json.loads(event["body"] or "{}")
    photo_id = body.get("photoId")
    if not photo_id:
        return respond(400, {"error": "photoId_required"})

    item = PHOTOS.get_item(Key={"photo_id": photo_id}).get("Item")
    if not item:
        return respond(404, {"error": "not_found"})

    keys = [item["original_key"]]
    for v in item.get("variants", {}).values():
        keys.append(v)

    # S3 first: only touch DDB if S3 succeeds.
    result = s3.delete_objects(
        Bucket=BUCKET,
        Delete={"Objects": [{"Key": k} for k in keys], "Quiet": False},
    )
    errors = result.get("Errors", [])
    if errors:
        # Single retry on the failed subset.
        failed_keys = [e["Key"] for e in errors]
        retry = s3.delete_objects(
            Bucket=BUCKET,
            Delete={"Objects": [{"Key": k} for k in failed_keys], "Quiet": False},
        )
        if retry.get("Errors"):
            return respond(500, {"error": "s3_delete_failed",
                                 "details": retry["Errors"]})

    PHOTOS.delete_item(Key={"photo_id": photo_id})
    return respond(200, {"deleted": photo_id})


def me(event):
    claims = (event.get("requestContext", {})
              .get("authorizer", {})
              .get("claims") or {})
    email = (claims.get("email") or "").lower()
    role = get_role(email)
    if role not in {"admin", "viewer"}:
        return respond(403, {"error": "forbidden"})
    return respond(200, {"role": role, "email": email})


def handler(event, _ctx):
    method = event.get("httpMethod")
    path = event.get("path", "")

    if method == "GET" and path.endswith("/admin/me"):
        return me(event)

    # Admin-only routes from here on.
    admin_email = require_admin(event)
    if not admin_email:
        return respond(403, {"error": "forbidden"})

    if method == "POST" and path.endswith("/admin/presign"):
        return presign(event)
    if method == "DELETE" and path.endswith("/admin/photo"):
        return delete_photo(event)

    return respond(404, {"error": "no_route"})
