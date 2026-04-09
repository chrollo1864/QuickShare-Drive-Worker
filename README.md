# QuickShare Drive Worker

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

## How to get the Google credentials

### 1. Create a Google Cloud project

* Open Google Cloud Console
* Create a new project or select an existing one
* Make sure billing is not required for basic Drive API testing in most cases

### 2. Enable the Google Drive API

* In **APIs & Services > Library**
* Search for **Google Drive API**
* Click **Enable**

### 3. Configure the OAuth consent screen

* Go to **APIs & Services > OAuth consent screen**
* Choose **External** for personal use, or **Internal** if you are using a Workspace account in your own org
* Fill in the basic app information
* Add your Google account as a **Test user** if the app is still in testing mode

### 4. Create OAuth client credentials

* Go to **APIs & Services > Credentials**
* Click **Create Credentials > OAuth client ID**
* For easiest local token generation, choose **Desktop app**
* Save the generated values

You will get:

* **Client ID** → use as `GOOGLE_CLIENT_ID`
* **Client Secret** → use as `GOOGLE_CLIENT_SECRET`

### 5. Get a refresh token

You need a refresh token because the Worker cannot do the interactive Google login flow by itself.

A common way is to generate it locally using a small script or OAuth playground-style flow.

#### Option A: Use a local Node.js script

Install `googleapis`:

```bash
npm install googleapis
```

Create a file like `get-refresh-token.js`:

```javascript
const http = require("http");
const { google } = require("googleapis");

const CLIENT_ID = "YOUR_CLIENT_ID";
const CLIENT_SECRET = "YOUR_CLIENT_SECRET";
const REDIRECT_URI = "http://localhost:3000/callback";

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

const scopes = ["https://www.googleapis.com/auth/drive.readonly"];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: scopes
});

console.log("Open this URL in your browser:
", authUrl);

http.createServer(async (req, res) => {
  if (!req.url.startsWith("/callback")) {
    res.end("Waiting for callback...");
    return;
  }

  const url = new URL(req.url, "http://localhost:3000");
  const code = url.searchParams.get("code");

  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log("
Refresh token:
", tokens.refresh_token);
    res.end("Done. Check your terminal for the refresh token.");
    process.exit(0);
  } catch (err) {
    console.error(err);
    res.end("Failed to get token.");
    process.exit(1);
  }
}).listen(3000, () => {
  console.log("Listening on http://localhost:3000");
});
```

Run it:

```bash
node get-refresh-token.js
```

Then:

* open the printed URL
* log in with the Google account that can access your files
* approve access
* copy the printed refresh token
* use it as `GOOGLE_REFRESH_TOKEN`

Important:

* keep `prompt: "consent"` and `access_type: "offline"`
* if Google does not return a refresh token, revoke the app access from your Google account and repeat the flow

### 6. Get the root folder ID

Open the folder in Google Drive and copy the ID from the URL.

Example:

```text
https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz
```

The folder ID is:

```text
1AbCdEfGhIjKlMnOpQrStUvWxYz
```

Use that as `ROOT_FOLDER_ID`.

### 7. Get the Shared Drive ID, if needed

If you are using a Shared Drive, open that drive and copy its ID from the URL, then save it as `DRIVE_ID`.

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

## Troubleshooting Google setup

### No refresh token returned

Usually caused by one of these:

* you did not use `access_type=offline`
* you did not force `prompt=consent`
* you already granted the app before, so Google reused the old consent

Fix:

* revoke the app from your Google account permissions
* run the auth flow again
* make sure `prompt: "consent"` is included

### The Worker can see folders but not files

Possible causes:

* wrong `ROOT_FOLDER_ID`
* the Google account used for the refresh token does not have access to nested content
* `DRIVE_ID` is missing for a Shared Drive

### Storage endpoint fails

Possible causes:

* Drive API not enabled
* refresh token is invalid or expired
* wrong client credentials

### Which account does the Worker use?

The Worker uses the Google account tied to the refresh token.
That account must have permission to access the target folder or Shared Drive.

## License

MIT License © 2026 Chrollo1864

You are free to use, modify, and distribute this project.

However, you MUST:
- Give proper credit to the original author
- Include a link to this repository

Example credit:
"Based on QuickShare Drive Worker by Chrollo1864"
