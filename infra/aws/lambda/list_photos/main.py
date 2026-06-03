import json
import os
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key

ddb = boto3.resource("dynamodb")
PHOTOS = ddb.Table(os.environ["PHOTOS_TABLE"])
USERS = ddb.Table(os.environ["USERS_TABLE"])
CDN = os.environ["CLOUDFRONT_DOMAIN"]

LIMIT = 60


def to_response(photos: list[dict]) -> dict:
    out = []
    for p in photos:
        variants = p.get("variants", {}) or {}
        out.append({
            "id": p["photo_id"],
            "title": p.get("title", ""),
            "isPublic": bool(p.get("is_public", False)),
            "createdAt": p.get("created_at"),
            "width": int(p.get("width", 1200)),
            "height": int(p.get("height", 800)),
            "urls": {
                size: f"https://{CDN}/{variants[size]}"
                for size in ("thumb", "medium", "large")
                if size in variants
            },
        })
    return {"photos": out}


def query_public() -> list[dict]:
    resp = PHOTOS.query(
        IndexName="public-index",
        KeyConditionExpression=Key("is_public_str").eq("true"),
        ScanIndexForward=False,
        Limit=LIMIT,
    )
    return resp["Items"]


def scan_all() -> list[dict]:
    resp = PHOTOS.scan(Limit=LIMIT * 4)
    items = resp["Items"]
    items.sort(key=lambda i: i.get("created_at", ""), reverse=True)
    return items[:LIMIT]


def is_whitelisted(email: str) -> bool:
    item = USERS.get_item(Key={"email": email.lower()}).get("Item")
    if not item:
        return False
    return item.get("role") in {"viewer", "admin"}


def respond(status: int, body: Any) -> dict:
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def handler(event, _ctx):
    claims = (event.get("requestContext", {})
              .get("authorizer", {})
              .get("claims") or {})
    email = claims.get("email")

    if email is None:
        return respond(200, to_response(query_public()))

    if not is_whitelisted(email):
        return respond(403, {"error": "not_whitelisted"})

    return respond(200, to_response(scan_all()))
