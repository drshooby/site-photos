#!/usr/bin/env python3
"""Manual orphan reconciliation between DDB and S3.

Usage:
  python scripts/reconcile.py [--apply]

Without --apply it only prints orphans.
"""
import argparse
import json
import os
import subprocess
import sys

import boto3


def tf_out(name: str) -> str:
    return subprocess.check_output(
        ["terraform", "output", "-raw", name],
        cwd=os.path.join(os.path.dirname(__file__), "..", "infra", "aws"),
    ).decode().strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    bucket = tf_out("s3_bucket_name")
    s3 = boto3.client("s3")
    ddb = boto3.client("dynamodb")
    table = "photos-photos"

    # All DDB photo_ids
    ddb_ids: set[str] = set()
    paginator = ddb.get_paginator("scan")
    for page in paginator.paginate(TableName=table, ProjectionExpression="photo_id"):
        for item in page["Items"]:
            ddb_ids.add(item["photo_id"]["S"])

    # All S3 photo_ids (from originals/ and processed/ key prefixes)
    s3_ids: set[str] = set()
    for prefix in ("originals/", "processed/"):
        for page in s3.get_paginator("list_objects_v2").paginate(
            Bucket=bucket, Prefix=prefix
        ):
            for obj in page.get("Contents", []):
                parts = obj["Key"].split("/", 2)
                if len(parts) >= 2:
                    s3_ids.add(parts[1])

    ddb_only = sorted(ddb_ids - s3_ids)
    s3_only = sorted(s3_ids - ddb_ids)

    print(f"DDB rows with no S3 keys: {len(ddb_only)}")
    for pid in ddb_only:
        print(f"  {pid}")
    print(f"S3 keys with no DDB row: {len(s3_only)}")
    for pid in s3_only:
        print(f"  {pid}")

    if not args.apply:
        return

    if not (ddb_only or s3_only):
        return
    confirm = input("Apply deletes? [y/N] ").strip().lower()
    if confirm != "y":
        return

    for pid in ddb_only:
        ddb.delete_item(TableName=table, Key={"photo_id": {"S": pid}})
        print(f"deleted DDB {pid}")

    for pid in s3_only:
        for prefix in ("originals/", "processed/"):
            objs = s3.list_objects_v2(Bucket=bucket, Prefix=f"{prefix}{pid}/").get("Contents", [])
            if objs:
                s3.delete_objects(
                    Bucket=bucket,
                    Delete={"Objects": [{"Key": o["Key"]} for o in objs]},
                )
        print(f"deleted S3 {pid}")


if __name__ == "__main__":
    main()
