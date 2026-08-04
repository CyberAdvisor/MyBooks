#!/usr/bin/env python3
"""
refresh_covers_from_google.py

Standalone tool (no MyBooks app code involved) to fill in missing book
covers using the official Google Books API, for books exported from the
app's Backup screen.

Why it works this way:
  - The app's data lives only in the browser (IndexedDB) - there's no API
    to write into it directly. The bridge is the app's own Backup/Restore
    JSON format: export a backup, run this script on that file, then
    Restore the updated file back into the app.
  - Only fills in `coverUrl` for books that don't already have one, same
    "never overwrite what's already there" rule the app itself uses for
    Refresh from Online Sources (use --force to override this).
  - Stores the Google-hosted cover URL directly (not a downloaded copy) -
    same as how the app's own online search already stores covers. Add
    --download if you want the image bytes embedded instead (see below).
  - Requires your own free Google Books API key (not shared/baked into
    any code) - see the setup steps below.

Setup:
  1. Get a free API key: console.cloud.google.com -> create/select a
     project -> Enable APIs & Services -> enable "Books API" ->
     Credentials -> Create Credentials -> API key.
  2. Either pass it with --api-key, or set it once:
       export GOOGLE_BOOKS_API_KEY="your-key-here"

Usage:
  python3 refresh_covers_from_google.py backup.json
  python3 refresh_covers_from_google.py backup.json --api-key AIza...
  python3 refresh_covers_from_google.py backup.json --output updated.json
  python3 refresh_covers_from_google.py backup.json --force        # also replace existing covers
  python3 refresh_covers_from_google.py backup.json --download     # embed image bytes as data: URIs

No third-party packages required (standard library only), matching the
app's own no-dependencies philosophy. Requires Python 3.7+.
"""
import argparse
import base64
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

GOOGLE_BOOKS_ENDPOINT = "https://www.googleapis.com/books/v1/volumes"


def find_cover_url(title, author, api_key):
    """
    Queries the Google Books API for a title/author and returns the best
    available cover image URL, or None if nothing usable was found.
    Prefers the largest image Google Books offers (extraLarge down to
    thumbnail), unlike the app's own in-browser search, which only ever
    asks for the small "thumbnail" size - this script isn't constrained
    by mobile bandwidth, so it asks for better quality when available.
    """
    query_parts = [title]
    if author:
        query_parts.append(f"inauthor:{author}")
    params = {"q": " ".join(query_parts)}
    if api_key:
        params["key"] = api_key

    url = f"{GOOGLE_BOOKS_ENDPOINT}?{urllib.parse.urlencode(params)}"

    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            data = json.load(response)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        if e.code == 429:
            print(f"    HTTP 429 (quota exceeded). {'Check your --api-key.' if not api_key else 'Your key may have hit its daily limit.'}")
        else:
            print(f"    HTTP {e.code}: {body[:200]}")
        return None
    except urllib.error.URLError as e:
        print(f"    Network error: {e.reason}")
        return None

    for item in data.get("items", []):
        image_links = item.get("volumeInfo", {}).get("imageLinks", {})
        for size in ("extraLarge", "large", "medium", "small", "thumbnail", "smallThumbnail"):
            if image_links.get(size):
                # Google serves these over http:// by default; upgrade to https.
                return image_links[size].replace("http://", "https://", 1)
    return None


def download_as_data_uri(url):
    """Downloads an image and returns it as a data: URI (base64-encoded)."""
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            content_type = response.headers.get_content_type() or mimetypes.guess_type(url)[0] or "image/jpeg"
            image_bytes = response.read()
    except (urllib.error.HTTPError, urllib.error.URLError) as e:
        print(f"    Could not download cover image: {e}")
        return None
    encoded = base64.b64encode(image_bytes).decode("ascii")
    return f"data:{content_type};base64,{encoded}"


def main():
    parser = argparse.ArgumentParser(description="Fill in missing MyBooks covers from the Google Books API.")
    parser.add_argument("backup_file", help="A JSON file exported from the app's Backup screen")
    parser.add_argument("--api-key", default=os.environ.get("GOOGLE_BOOKS_API_KEY"),
                         help="Google Books API key (or set GOOGLE_BOOKS_API_KEY). Optional but strongly recommended - see the setup notes at the top of this file.")
    parser.add_argument("--output", help="Where to write the updated JSON (default: <input>_updated.json)")
    parser.add_argument("--force", action="store_true", help="Also replace covers that are already set (default: only fill in missing ones)")
    parser.add_argument("--download", action="store_true", help="Embed the image itself as a data: URI instead of just linking Google's URL")
    parser.add_argument("--delay", type=float, default=0.5, help="Seconds to wait between requests (default: 0.5)")
    args = parser.parse_args()

    if not args.api_key:
        print("Warning: no API key set (--api-key or GOOGLE_BOOKS_API_KEY). Continuing without one,")
        print("but Google Books' keyless quota is commonly exhausted and this will likely fail with a 429.\n")

    with open(args.backup_file, "r", encoding="utf-8") as f:
        books = json.load(f)

    if not isinstance(books, list):
        sys.exit("Error: this doesn't look like a MyBooks backup file (expected a JSON array of books).")

    found, skipped, not_found = 0, 0, 0

    for i, book in enumerate(books, start=1):
        title = book.get("title", "")
        author = book.get("author", "")
        label = f"{title} - {author}" if author else title

        if book.get("coverUrl") and not args.force:
            print(f"[{i}/{len(books)}] Skipping (already has a cover): {label}")
            skipped += 1
            continue

        if not title:
            print(f"[{i}/{len(books)}] Skipping (no title): {label}")
            skipped += 1
            continue

        print(f"[{i}/{len(books)}] Looking up: {label}")
        cover_url = find_cover_url(title, author, args.api_key)

        if not cover_url:
            print("    No cover found.")
            not_found += 1
        else:
            if args.download:
                data_uri = download_as_data_uri(cover_url)
                book["coverUrl"] = data_uri if data_uri else cover_url
                print(f"    Downloaded cover ({'embedded' if data_uri else 'kept as URL - download failed'}).")
            else:
                book["coverUrl"] = cover_url
                print(f"    Found cover: {cover_url}")
            found += 1

        time.sleep(args.delay)

    output_path = args.output or f"{os.path.splitext(args.backup_file)[0]}_updated.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(books, f, indent=2, ensure_ascii=False)

    print(f"\nDone. {found} cover(s) found, {skipped} skipped, {not_found} not found.")
    print(f"Wrote: {output_path}")
    print("Import this file in the app via Backup -> Restore from Backup File.")


if __name__ == "__main__":
    main()
