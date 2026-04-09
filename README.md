#  GDrive Worker

A modern Google Drive index and file-sharing app built on **Cloudflare Workers**.

It combines a clean web UI, direct file delivery, preview support, storage insights, and compatibility with older GOIndex-style links.

## Features

### Modern file-sharing UI

* Clean three-panel layout for browsing, activity, and storage status
* Responsive design for desktop and mobile
* Search bar for quickly finding files and folders
* Breadcrumb navigation for moving through folders
* Load-more pagination for larger directories

### File browsing

* Shows folders and files from the configured Google Drive root
* Displays thumbnails when available
* Shows file size, modified time, and file type
* Supports folder-by-folder navigation

### Inline preview support

The app can preview supported files directly inside a custom modal viewer.

Supported preview types:

* Images
* Videos
* Audio
* PDF files

Preview UI includes:

* Large modal viewer
* File title and subtitle
* Download button
* Open raw file button
* File details sidebar
* Fallback download UI for unsupported file types

### Direct download support

* Files can be downloaded directly from the UI
* Download responses use header-safe filenames
* Preserves browser-friendly content headers
* Supports range requests for media playback and seeking

### Legacy link compatibility

Old-style GOIndex links still work.

Examples:

```text
/0:/movie.mkv
```

Downloads automatically.

```text
/0:/movie.mkv?a=view
```

Opens inline preview when the file type is supported.

This is useful if you already shared older links and do not want them to break after switching to this Worker.

### Storage status ring

The right-side panel includes a live storage widget powered by the Google Drive `about` endpoint.

It shows:

* Percentage used
* Total quota
* Used space
* Usage in Drive
* Usage in Trash
* Connected account identity

### Useful side panels

The UI also includes side panels for:

* Current workspace label
* Current root folder label
* Current view mode
* Recent activity based on modified files
* Device/status blocks for quick UI context

### Shared Drive support

If you use a Shared Drive, the Worker can query that drive by setting `DRIVE_ID`.

### Cloudflare-friendly architecture

* Runs entirely on Cloudflare Workers
* Uses edge caching for Drive metadata requests
* Uses OAuth refresh-token flow to access Google Drive
* Keeps the frontend and API in one Worker script

## API routes

### `GET /api/list`

Lists items inside a parent folder.

Query params:

* `parent` – folder ID
* `pageToken` – pagination token
* `pageSize` – items per page

### `GET /api/search`

Searches items by file name.

Query params:

* `q` – search string
* `pageToken` – pagination token
* `pageSize` – items per page

### `GET /api/file`

Streams or downloads a file.

Query params:

* `id` – Google Drive file ID
* `download=1` – force download

### `GET /api/breadcrumbs`

Builds breadcrumb data for a folder.

Query params:

* `id` – folder ID

### `GET /api/storage`

Returns Google Drive account storage information.

## Required environment variables

Add these in **Cloudflare Workers Secrets / Variables**:

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
ROOT_FOLDER_ID
```

## Optional environment variables

```text
DRIVE_ID
SITE_NAME
```

### Variable notes

* `ROOT_FOLDER_ID` → the folder used as the app root
* `DRIVE_ID` → only needed for Shared Drives
* `SITE_NAME` → custom title shown in the UI

## How legacy routing works

The Worker detects old-style paths like:

```text
/0:/path/to/file.mkv
```

It resolves the path segment-by-segment starting from `ROOT_FOLDER_ID`, finds the matching file, then serves it using the modern file handler.

Behavior:

* normal legacy URL → download
* `?a=view` → preview/inline mode

## Preview behavior

Preview mode depends on the file MIME type or detected file extension.

Inline-safe formats:

* `image/*`
* `video/*`
* `audio/*`
* `application/pdf`

Other file types fall back to download mode.

## Why this project is useful

This Worker is good for people who want:

* a self-hosted-looking file portal on Cloudflare
* a nicer Google Drive index UI
* working media previews
* backward compatibility with old shared links
* a lightweight GOIndex alternative with a more modern interface

## Suggested future improvements

Possible upgrades for later:

* Grid/List toggle
* Copy direct link button
* Fullscreen preview
* Next/previous preview navigation
* Folder deep-link opening in the UI from legacy folder URLs
* Subtitle auto-detection for video files
* Password-protected routes
* Better movie/series metadata cards

## License

Use and modify this project however you like for your own deployment and workflow.
