export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/api/list") return listHandler(env, url);
      if (path === "/api/search") return searchHandler(env, url);
      if (path === "/api/file") return fileHandler(request, env, url);
      if (path === "/api/breadcrumbs") return breadcrumbsHandler(env, url);
      if (path === "/api/storage") return storageHandler(env);
      if (path === "/favicon.ico") return new Response(null, { status: 204 });

      const legacyMatch = path.match(/^\/(\d+):\/(.*)$/);
      if (legacyMatch) {
        return handleLegacyRoute(request, env, url, legacyMatch[2]);
      }

      return htmlResponse(renderApp(env), {
        headers: { "Cache-Control": "public, max-age=300" }
      });
    } catch (error) {
      return jsonResponse({ error: error.message || "Unexpected error" }, 500);
    }
  }
};

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FOLDER_MIME = "application/vnd.google-apps.folder";

let tokenCache = {
  accessToken: null,
  expiresAt: 0
};

async function listHandler(env, url) {
  const parentId = url.searchParams.get("parent") || env.ROOT_FOLDER_ID;
  const pageToken = url.searchParams.get("pageToken") || "";
  const pageSize = clampInt(url.searchParams.get("pageSize"), 18, 1, 100);

  const q = [`'${escapeDriveId(parentId)}' in parents`, "trashed = false"].join(" and ");

  const data = await driveList(env, {
    q,
    pageSize,
    pageToken,
    orderBy: "folder,name_natural",
    fields:
      "nextPageToken, files(id,name,mimeType,size,modifiedTime,thumbnailLink,iconLink,webViewLink,parents)"
  });

  return jsonResponse({
    parentId,
    files: (data.files || []).map(normalizeFile),
    nextPageToken: data.nextPageToken || null
  });
}

async function searchHandler(env, url) {
  const query = (url.searchParams.get("q") || "").trim();
  const pageToken = url.searchParams.get("pageToken") || "";
  const pageSize = clampInt(url.searchParams.get("pageSize"), 18, 1, 100);

  if (!query) {
    return jsonResponse({ q: "", files: [], nextPageToken: null });
  }

  const safeQuery = query.replace(/'/g, "\\'");
  const q = [`name contains '${safeQuery}'`, "trashed = false"].join(" and ");

  const data = await driveList(env, {
    q,
    pageSize,
    pageToken,
    orderBy: "folder,name_natural",
    fields:
      "nextPageToken, files(id,name,mimeType,size,modifiedTime,thumbnailLink,iconLink,webViewLink,parents)"
  });

  return jsonResponse({
    q: query,
    files: (data.files || []).map(normalizeFile),
    nextPageToken: data.nextPageToken || null
  });
}

async function fileHandler(request, env, url) {
  const id = url.searchParams.get("id");
  const download = url.searchParams.get("download") === "1";

  if (!id) {
    return jsonResponse({ error: "Missing file id" }, 400);
  }

  const meta = await driveGet(
    env,
    id,
    "id,name,mimeType,size,modifiedTime,thumbnailLink,webViewLink"
  );
  const accessToken = await getAccessToken(env);

  const upstream = await fetch(
    `${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
    {
      headers: buildDriveHeaders(accessToken, request.headers)
    }
  );

  if (!upstream.ok) {
    return new Response(await upstream.text(), { status: upstream.status });
  }

  const headers = new Headers(upstream.headers);
  headers.set("Content-Type", guessMime(meta.mimeType, meta.name));
  headers.set(
    "Content-Disposition",
    contentDisposition(
      meta.name,
      download ? "attachment" : isInlineSafe(meta.mimeType, meta.name) ? "inline" : "attachment"
    )
  );
  headers.set("Cache-Control", "public, max-age=3600");
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(upstream.body, {
    status: upstream.status,
    headers
  });
}

async function breadcrumbsHandler(env, url) {
  const id = url.searchParams.get("id") || env.ROOT_FOLDER_ID;
  const items = [];
  const visited = new Set();
  let cursor = id;

  for (let i = 0; i < 20 && cursor && !visited.has(cursor); i += 1) {
    visited.add(cursor);
    const file = await driveGet(env, cursor, "id,name,parents");
    items.unshift({ id: file.id, name: file.name });
    if (file.id === env.ROOT_FOLDER_ID) break;
    cursor = file.parents?.[0] || null;
  }

  return jsonResponse({ items });
}

async function storageHandler(env) {
  const data = await driveAbout(env);
  const quota = data.storageQuota || {};
  return jsonResponse({
    user: data.user || null,
    total: Number(quota.limit || 0),
    used: Number(quota.usage || 0),
    usedInDrive: Number(quota.usageInDrive || 0),
    usedInTrash: Number(quota.usageInDriveTrash || 0)
  });
}

async function handleLegacyRoute(request, env, url, rawPath) {
  const cleanedPath = decodeURIComponent(rawPath || "").replace(/^\/+/, "");

  if (!cleanedPath) {
    return htmlResponse(renderApp(env), {
      headers: { "Cache-Control": "public, max-age=300" }
    });
  }

  const entry = await resolvePathToEntry(env, cleanedPath);
  if (!entry) {
    return new Response("File not found", { status: 404 });
  }

  if (entry.mimeType === FOLDER_MIME) {
    return htmlResponse(renderApp(env), {
      headers: { "Cache-Control": "public, max-age=300" }
    });
  }

  const legacyUrl = new URL(request.url);
  legacyUrl.searchParams.set("id", entry.id);

  if (url.searchParams.get("a") === "view") {
    legacyUrl.searchParams.delete("download");
  } else {
    legacyUrl.searchParams.set("download", "1");
  }

  return fileHandler(request, env, legacyUrl);
}

async function resolvePathToEntry(env, pathText) {
  const parts = pathText
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));

  if (!parts.length) return null;

  let parentId = env.ROOT_FOLDER_ID;

  for (let i = 0; i < parts.length; i += 1) {
    const isLast = i === parts.length - 1;
    const name = parts[i].replace(/'/g, "\\'");
    const q = isLast
      ? [`'${escapeDriveId(parentId)}' in parents`, `name = '${name}'`, "trashed = false"].join(" and ")
      : [`'${escapeDriveId(parentId)}' in parents`, `name = '${name}'`, `mimeType = '${FOLDER_MIME}'`, "trashed = false"].join(" and ");

    const result = await driveList(env, {
      q,
      pageSize: 5,
      pageToken: "",
      orderBy: "name_natural",
      fields: "files(id,name,mimeType,size,modifiedTime,thumbnailLink,iconLink,webViewLink,parents)"
    });

    const found = (result.files || [])[0];
    if (!found) return null;
    if (!isLast && found.mimeType !== FOLDER_MIME) return null;

    if (isLast) return found;
    parentId = found.id;
  }

  return null;
}

async function driveList(env, params) {
  const qs = new URLSearchParams({
    q: params.q,
    pageSize: String(params.pageSize || 18),
    includeItemsFromAllDrives: "true",
    supportsAllDrives: "true",
    orderBy: params.orderBy || "folder,name_natural",
    fields: params.fields || "nextPageToken, files(id,name,mimeType)"
  });

  if (params.pageToken) qs.set("pageToken", params.pageToken);

  if (env.DRIVE_ID) {
    qs.set("driveId", env.DRIVE_ID);
    qs.set("corpora", "drive");
  } else {
    qs.set("corpora", "user");
  }

  return driveFetchJson(env, `${DRIVE_API}/files?${qs.toString()}`, { ttl: 120 });
}

async function driveGet(env, fileId, fields) {
  const qs = new URLSearchParams({
    supportsAllDrives: "true",
    fields
  });
  return driveFetchJson(env, `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${qs.toString()}`, {
    ttl: 120
  });
}

async function driveAbout(env) {
  const qs = new URLSearchParams({
    fields: "user(displayName,emailAddress,photoLink),storageQuota(limit,usage,usageInDrive,usageInDriveTrash)"
  });
  return driveFetchJson(env, `${DRIVE_API}/about?${qs.toString()}`, { ttl: 300 });
}

async function driveFetchJson(env, url, { ttl = 60 } = {}) {
  const cache = caches.default;
  const cacheKey = new Request(url, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const accessToken = await getAccessToken(env);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    throw new Error(`Google Drive API error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const cachedResponse = new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${ttl}`
    }
  });
  await cache.put(cacheKey, cachedResponse.clone());
  return data;
}

async function getAccessToken(env) {
  const now = Date.now();

  if (tokenCache.accessToken && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.accessToken;
  }

  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: "refresh_token"
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: now + ((data.expires_in || 3600) * 1000)
  };

  return tokenCache.accessToken;
}

function buildDriveHeaders(accessToken, incomingHeaders) {
  const headers = new Headers({ Authorization: `Bearer ${accessToken}` });
  const range = incomingHeaders.get("range");
  if (range) headers.set("Range", range);
  return headers;
}

function normalizeFile(file) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size ? Number(file.size) : null,
    modifiedTime: file.modifiedTime || null,
    thumbnailLink: file.thumbnailLink || null,
    iconLink: file.iconLink || null,
    webViewLink: file.webViewLink || null,
    isFolder: file.mimeType === FOLDER_MIME,
    kind: classifyFile(file),
    inline: isInlineSafe(file.mimeType, file.name)
  };
}

function classifyFile(file) {
  const mime = file.mimeType || "";
  if (mime === FOLDER_MIME) return "folder";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  return "file";
}

function isInlineSafe(mimeType = "", name = "") {
  const mime = guessMime(mimeType, name);
  return /^image\//.test(mime) || /^video\//.test(mime) || /^audio\//.test(mime) || mime === "application/pdf";
}

function guessMime(mimeType = "", name = "") {
  if (mimeType && !mimeType.startsWith("application/vnd.google-apps")) return mimeType;

  const ext = (name.split(".").pop() || "").toLowerCase();
  const map = {
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    flac: "audio/flac",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    txt: "text/plain; charset=utf-8",
    srt: "text/plain; charset=utf-8",
    vtt: "text/vtt; charset=utf-8"
  };

  return map[ext] || "application/octet-stream";
}

function contentDisposition(filename, type = "attachment") {
  const fallback = asciiFallbackFilename(filename);
  const encoded = encodeRFC5987ValueChars(filename);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function asciiFallbackFilename(name) {
  return (
    String(name || "download")
      .normalize("NFKD")
      .replace(/[^\x20-\x7E]/g, "")
      .replace(/[\\"]/g, "_")
      .replace(/[\r\n]/g, " ")
      .trim() || "download"
  );
}

function encodeRFC5987ValueChars(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function escapeDriveId(value) {
  return String(value).replace(/'/g, "\\'");
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function htmlResponse(html, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "text/html; charset=utf-8");
  }
  return new Response(html, { ...init, headers });
}

function renderApp(env) {
  const siteName = env.SITE_NAME || "QuickShare Drive";
  const rootId = env.ROOT_FOLDER_ID || "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(siteName)}</title>
  <style>
    :root {
      --bg: #ececf8;
      --bg-2: #f7f7fc;
      --card: rgba(255,255,255,.78);
      --line: rgba(27,35,93,.08);
      --text: #1d2340;
      --muted: #8a90ab;
      --navy: #171e52;
      --navy-2: #202a6e;
      --pink: #ff6f86;
      --pink-2: #ff5f7d;
      --violet: #7d6dff;
      --sky: #67c2ff;
      --green: #45d59b;
      --shadow: 0 24px 60px rgba(35,42,87,.13);
    }

    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    body {
      font-family: Inter, system-ui, sans-serif;
      background:
        radial-gradient(circle at top left, rgba(126,109,255,.15), transparent 25%),
        radial-gradient(circle at bottom right, rgba(255,111,134,.10), transparent 24%),
        linear-gradient(135deg, var(--bg), var(--bg-2));
      color: var(--text);
      padding: 24px;
    }

    .wrap {
      display: grid;
      grid-template-columns: 320px 1fr 340px;
      gap: 22px;
      max-width: 1480px;
      margin: 0 auto;
      align-items: start;
    }

    .card {
      background: var(--card);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      border-radius: 32px;
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
    }

    .left {
      min-height: calc(100vh - 48px);
      background: linear-gradient(180deg, #1f2664, #151a4f);
      color: #fff;
      padding: 26px;
      position: sticky;
      top: 24px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    .hero-box {
      border-radius: 28px;
      background: linear-gradient(180deg, rgba(255,255,255,.94), rgba(245,247,255,.90));
      min-height: 210px;
      display: grid;
      place-items: center;
      color: #151a4f;
      position: relative;
      overflow: hidden;
    }

    .hero-ring {
      width: 140px;
      height: 140px;
      border-radius: 50%;
      border: 16px solid rgba(125,109,255,.16);
      display: grid;
      place-items: center;
      position: relative;
    }

    .hero-ring::after {
      content: "";
      position: absolute;
      inset: -12px;
      border-radius: 50%;
      border: 1px dashed rgba(255,111,134,.35);
    }

    .hero-ring span {
      font-size: 52px;
      font-weight: 800;
    }

    .left h1 {
      margin: 0;
      font-size: 36px;
      line-height: 1.02;
      letter-spacing: -.04em;
    }

    .left p.lead {
      margin: 0;
      color: rgba(255,255,255,.76);
      line-height: 1.65;
      font-size: 14px;
    }

    .left-utility {
      background: rgba(255,255,255,.08);
      border: 1px solid rgba(255,255,255,.10);
      border-radius: 24px;
      padding: 16px;
      display: grid;
      gap: 12px;
    }

    .utility-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      font-size: 13px;
    }

    .utility-label { color: rgba(255,255,255,.68); }
    .utility-value { color: #fff; font-weight: 700; text-align: right; }

    .btn {
      border: 0;
      border-radius: 18px;
      padding: 14px 16px;
      font-weight: 700;
      cursor: pointer;
      transition: transform .18s ease, opacity .18s ease;
      font: inherit;
      text-decoration: none;
      text-align: center;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }

    .btn:hover { transform: translateY(-1px); opacity: .96; }
    .btn-pink {
      background: linear-gradient(135deg, var(--pink), var(--pink-2));
      color: #fff;
      width: 100%;
      box-shadow: 0 18px 28px rgba(255,95,125,.28);
    }
    .btn-dark { background: linear-gradient(135deg, #1f2664, #202a6e); color: #fff; }
    .btn-soft { background: rgba(31,38,100,.06); color: #1f2664; }

    .mid { display: flex; flex-direction: column; gap: 20px; }
    .top { padding: 22px; }
    .brand {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      gap: 12px;
    }

    .brand-title strong { display: block; font-size: 28px; letter-spacing: -.03em; }
    .brand-title span { color: var(--muted); font-size: 14px; }

    .toolbar {
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 12px;
      margin-bottom: 14px;
    }

    .search {
      padding: 14px 16px;
      border-radius: 18px;
      background: #fff;
      border: 1px solid rgba(27,35,93,.08);
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .search input {
      width: 100%;
      border: 0;
      outline: 0;
      background: transparent;
      font: inherit;
      color: var(--text);
    }

    .tabs {
      display: inline-flex;
      background: rgba(31,38,100,.06);
      padding: 8px;
      border-radius: 18px;
      gap: 8px;
    }

    .tabs button {
      border: 0;
      background: transparent;
      padding: 10px 14px;
      border-radius: 14px;
      font-weight: 700;
      cursor: pointer;
      color: var(--muted);
      font: inherit;
    }

    .tabs .active { background: #1f2664; color: #fff; }

    .content { padding: 20px; }
    .head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 14px;
    }
    .head h2 { margin: 0; font-size: 38px; letter-spacing: -.04em; }

    .crumbs {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }

    .crumb {
      border: 0;
      background: rgba(31,38,100,.06);
      padding: 10px 14px;
      border-radius: 999px;
      font-weight: 700;
      cursor: pointer;
      color: var(--navy);
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 16px;
    }

    .stat {
      background: #fff;
      border: 1px solid rgba(27,35,93,.08);
      padding: 16px;
      border-radius: 22px;
    }

    .stat small { display: block; color: var(--muted); }
    .stat b { display: block; font-size: 22px; margin-top: 8px; }

    .grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }

    .file {
      background: #fff;
      border: 1px solid rgba(27,35,93,.08);
      border-radius: 24px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .thumb {
      height: 146px;
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, rgba(31,38,100,.06), rgba(126,109,255,.16));
      font-size: 44px;
    }

    .thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .body {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-height: 170px;
      min-width: 0;
    }

    .name {
      font-weight: 800;
      line-height: 1.38;
      word-break: break-word;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
      min-height: 58px;
    }

    .meta {
      font-size: 12px;
      color: var(--muted);
      margin-top: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .actions {
      display: flex;
      gap: 10px;
      margin-top: auto;
    }

    .actions > * {
      flex: 1;
    }

    .right {
      display: flex;
      flex-direction: column;
      gap: 18px;
      position: sticky;
      top: 24px;
    }

    .mini { padding: 22px; }

    .storage-card {
      background: linear-gradient(180deg, #1f2664, #1a215c);
      color: #fff;
      text-align: center;
      overflow: hidden;
    }

    .storage-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      text-align: left;
    }

    .storage-top span { color: rgba(255,255,255,.72); font-size: 14px; }

    .storage-ring-wrap {
      width: 220px;
      margin: 0 auto 18px;
      position: relative;
    }

    .storage-ring {
      width: 220px;
      height: 220px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: conic-gradient(var(--pink) calc(var(--progress, 0) * 1%), rgba(255,255,255,.11) 0);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.06);
      transition: background .4s ease;
    }

    .storage-ring::before {
      content: "";
      width: 158px;
      height: 158px;
      border-radius: 50%;
      background: linear-gradient(180deg, #202964, #1b215b);
      display: block;
      box-shadow: inset 0 0 0 18px rgba(255,255,255,.05);
    }

    .storage-center {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      z-index: 2;
      padding: 52px;
      text-align: center;
    }

    .storage-percent {
      font-size: 34px;
      font-weight: 800;
      line-height: 1;
    }

    .storage-sub {
      margin-top: 8px;
      color: rgba(255,255,255,.72);
      font-size: 13px;
      line-height: 1.45;
    }

    .storage-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 10px;
    }

    .storage-chip {
      text-align: left;
      padding: 12px 14px;
      border-radius: 18px;
      background: rgba(255,255,255,.08);
      border: 1px solid rgba(255,255,255,.08);
    }

    .storage-chip small { display: block; color: rgba(255,255,255,.64); }
    .storage-chip strong { display: block; margin-top: 6px; font-size: 16px; }

    .list { display: flex; flex-direction: column; gap: 10px; }

    .item {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 18px;
      background: #fff;
      border: 1px solid rgba(27,35,93,.08);
      min-width: 0;
    }

    .item-main {
      min-width: 0;
      flex: 1;
    }

    .item-title {
      font-weight: 700;
      line-height: 1.35;
      word-break: break-word;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .item-sub {
      font-size: 12px;
      color: var(--muted);
      margin-top: 4px;
    }

    .item-side {
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
      flex-shrink: 0;
      text-align: right;
    }

    .empty {
      grid-column: 1 / -1;
      padding: 36px 18px;
      text-align: center;
      color: var(--muted);
      background: #fff;
      border: 1px solid rgba(27,35,93,.08);
      border-radius: 24px;
    }

    .modal {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(14,18,44,.56);
      z-index: 50;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
    }

    .modal.open { display: flex; }

    .modal-card {
      width: min(1240px, 100%);
      height: min(90vh, 920px);
      background: rgba(255,255,255,.96);
      border-radius: 30px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-shadow: 0 30px 90px rgba(19, 26, 78, .28);
      border: 1px solid rgba(255,255,255,.65);
    }

    .modal-head {
      padding: 18px 22px;
      border-bottom: 1px solid rgba(27,35,93,.08);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      background: rgba(255,255,255,.88);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
    }

    .modal-head-left {
      min-width: 0;
      flex: 1;
    }

    .modal-title {
      font-size: 18px;
      font-weight: 800;
      line-height: 1.3;
      margin: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .modal-subtitle {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .modal-head-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }

    .modal-stage {
      flex: 1;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 300px;
      min-height: 0;
      background: linear-gradient(180deg, #f8f9fe, #f3f5fd);
    }

    .modal-body {
      min-height: 0;
      background: radial-gradient(circle at top left, rgba(126,109,255,.09), transparent 24%), #f8f9fe;
      display: grid;
      place-items: center;
      overflow: auto;
      padding: 18px;
    }

    .modal-preview-shell {
      width: 100%;
      height: 100%;
      border-radius: 24px;
      background: rgba(255,255,255,.82);
      border: 1px solid rgba(27,35,93,.08);
      box-shadow: 0 18px 40px rgba(31,38,100,.08);
      overflow: hidden;
      display: grid;
      place-items: center;
    }

    .modal-body iframe,
    .modal-body img,
    .modal-body video,
    .modal-body audio {
      width: 100%;
      height: 100%;
      object-fit: contain;
      border: 0;
      display: block;
      background: transparent;
    }

    .modal-sidebar {
      border-left: 1px solid rgba(27,35,93,.08);
      background: rgba(255,255,255,.86);
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-height: 0;
      overflow: auto;
    }

    .preview-stat {
      border-radius: 20px;
      background: rgba(31,38,100,.05);
      border: 1px solid rgba(27,35,93,.06);
      padding: 14px;
    }

    .preview-stat small {
      display: block;
      color: var(--muted);
      margin-bottom: 6px;
    }

    .preview-stat strong {
      display: block;
      font-size: 14px;
      line-height: 1.45;
      word-break: break-word;
    }

    .preview-actions {
      display: grid;
      gap: 10px;
    }

    .preview-note {
      border-radius: 18px;
      background: rgba(255,111,134,.08);
      color: #7c3550;
      padding: 12px 14px;
      font-size: 12px;
      line-height: 1.55;
    }

    .preview-fallback {
      padding: 24px;
      text-align: center;
      color: var(--muted);
      line-height: 1.7;
    }

    @media (max-width: 1280px) {
      .wrap { grid-template-columns: 280px 1fr; }
      .right {
        position: static;
        grid-column: 1 / -1;
        display: grid;
        grid-template-columns: 1fr 1fr;
      }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }

    @media (max-width: 980px) {
      .modal-stage { grid-template-columns: 1fr; }
      .modal-sidebar {
        border-left: 0;
        border-top: 1px solid rgba(27,35,93,.08);
      }
    }

    @media (max-width: 920px) {
      .wrap { grid-template-columns: 1fr; }
      .left, .right { position: static; min-height: auto; }
      .toolbar { grid-template-columns: 1fr; }
      .grid { grid-template-columns: 1fr; }
      .stats { grid-template-columns: repeat(2, 1fr); }
      .right { grid-template-columns: 1fr; }
    }

    @media (max-width: 640px) {
      body { padding: 14px; }
      .head h2 { font-size: 30px; }
      .stats { grid-template-columns: 1fr; }
      .storage-grid { grid-template-columns: 1fr; }
    }

    .credit-tag {
    margin-top: auto;
    font-size: 12px;
    opacity: 0.7;
    text-align: center;
  }
  
  .credit-tag a {
    color: #ffffff;
    text-decoration: none;
    font-weight: 700;
    position: relative;
    z-index: 1;
  }
  
  .credit-tag a::after {
    content: "";
    position: absolute;
    inset: -2px;
    border-radius: 6px;
    background: linear-gradient(135deg, #ff6f86, #7d6dff);
    opacity: 0;
    z-index: -1;
    transition: opacity 0.3s ease;
  }
  
  .credit-tag a:hover::after {
    opacity: 0.25;
  }
  
  .credit-tag a:hover {
    color: #fff;
  }
  </style>
</head>
<body>
  <div class="wrap">
    <aside class="card left">
      <div class="hero-box">
        <div class="hero-ring"><span>⇪</span></div>
      </div>

      <div>
        <h1>Share smarter,<br>not just prettier</h1>
        <p class="lead">Browse folders, preview media, monitor storage usage, and surface your latest uploads in one actual useful workspace.</p>
      </div>

      <div class="left-utility">
        <div class="utility-row"><span class="utility-label">Workspace</span><span class="utility-value">${escapeHtml(siteName)}</span></div>
        <div class="utility-row"><span class="utility-label">Root Folder</span><span id="leftRootLabel" class="utility-value">Loading...</span></div>
        <div class="utility-row"><span class="utility-label">Current View</span><span id="leftModeLabel" class="utility-value">Browse</span></div>
      </div>

      <button id="homeHeroBtn" class="btn btn-pink">Open My Drive</button>

      <div class="credit-tag">
      by <a href="https://github.com/chrollo1864" target="_blank">Shishio</a>
      </div>

      </aside>

    <main class="mid">
      <section class="card top">
        <div class="brand">
          <div class="brand-title">
            <strong>${escapeHtml(siteName)}</strong>
            <span>Cloudflare Workers file sharing</span>
          </div>
          <button id="refreshBtn" class="btn btn-soft">Refresh</button>
        </div>

        <div class="toolbar">
          <label class="search">
            <span>⌕</span>
            <input id="searchInput" placeholder="Search files, folders, videos, PDFs...">
          </label>
          <button id="searchBtn" class="btn btn-dark">Search</button>
          <button id="clearBtn" class="btn btn-soft">Clear</button>
        </div>

        <div class="tabs">
          <button id="tabBrowse" class="active">Browse</button>
          <button id="tabRecent">Recent</button>
          <button id="tabShared">Shared</button>
        </div>
      </section>

      <section class="card content">
        <div class="head">
          <div>
            <h2 id="sectionTitle">All Files</h2>
            <div id="statusText" style="color:#8a90ab">Browse your folder and preview supported files instantly.</div>
          </div>
          <button id="upBtn" class="btn btn-soft">Go Up</button>
        </div>

        <div id="breadcrumbs" class="crumbs"></div>

        <div class="stats">
          <div class="stat"><small>Items</small><b id="statItems">0</b></div>
          <div class="stat"><small>Folders</small><b id="statFolders">0</b></div>
          <div class="stat"><small>Previewable</small><b id="statPreviewable">0</b></div>
          <div class="stat"><small>Download Size</small><b id="statSize">0 B</b></div>
        </div>

        <div id="fileGrid" class="grid"></div>
        <button id="loadMoreBtn" class="btn btn-soft" style="width:100%;margin-top:16px;display:none">Load more</button>
      </section>
    </main>

    <aside class="right">
      <section class="card mini storage-card">
        <div class="storage-top">
          <div>
            <strong>Storage status</strong><br>
            <span id="storageUser">Loading account...</span>
          </div>
          <span id="storageBadge">Live</span>
        </div>

        <div class="storage-ring-wrap">
          <div id="storageRing" class="storage-ring" style="--progress:0"></div>
          <div class="storage-center">
            <div>
              <div id="storagePercent" class="storage-percent">0%</div>
              <div id="storageSub" class="storage-sub">Calculating storage</div>
            </div>
          </div>
        </div>

        <div class="storage-grid">
          <div class="storage-chip"><small>Used</small><strong id="storageUsed">0 B</strong></div>
          <div class="storage-chip"><small>Total</small><strong id="storageTotal">0 B</strong></div>
          <div class="storage-chip"><small>Drive files</small><strong id="storageDrive">0 B</strong></div>
          <div class="storage-chip"><small>Trash</small><strong id="storageTrash">0 B</strong></div>
        </div>
      </section>

      <section class="card mini">
        <h3 style="margin:0 0 12px">Available devices</h3>
        <div class="list">
          <div class="item"><div class="item-main"><div class="item-title">Desktop Browser</div><div class="item-sub">Current session</div></div><div class="item-side">Online</div></div>
          <div class="item"><div class="item-main"><div class="item-title">Mobile Preview</div><div class="item-sub">Responsive layout ready</div></div><div class="item-side">Ready</div></div>
          <div class="item"><div class="item-main"><div class="item-title">Media Screen</div><div class="item-sub">Video and audio playback capable</div></div><div class="item-side">Ready</div></div>
        </div>
      </section>

      <section class="card mini">
        <h3 style="margin:0 0 12px">Recent activity</h3>
        <div id="activityList" class="list">
          <div class="item"><div class="item-main"><div class="item-title">Waiting for files</div><div class="item-sub">Open a folder to populate activity</div></div><div class="item-side">Now</div></div>
        </div>
      </section>
    </aside>
  </div>

  <div id="previewModal" class="modal">
    <div class="modal-card">
      <div class="modal-head">
        <div class="modal-head-left">
          <div id="modalTitle" class="modal-title">Preview</div>
          <div id="modalSubtitle" class="modal-subtitle">Open a file to preview it here</div>
        </div>
        <div class="modal-head-actions">
          <a id="modalDownloadBtn" class="btn btn-pink" href="#" target="_blank" rel="noopener">Download</a>
          <button id="closeModalBtn" class="btn btn-soft">Close</button>
        </div>
      </div>
      <div class="modal-stage">
        <div id="modalBody" class="modal-body"></div>
        <aside class="modal-sidebar">
          <div class="preview-stat"><small>File name</small><strong id="previewName">—</strong></div>
          <div class="preview-stat"><small>Type</small><strong id="previewType">—</strong></div>
          <div class="preview-stat"><small>Preview mode</small><strong id="previewMode">—</strong></div>
          <div class="preview-actions">
            <a id="sidebarDownloadBtn" class="btn btn-dark" href="#" target="_blank" rel="noopener">Download file</a>
            <a id="sidebarOpenBtn" class="btn btn-soft" href="#" target="_blank" rel="noopener">Open raw file</a>
          </div>
          <div class="preview-note">Images, videos, audio, and PDFs open inline. Other file types fall back to download so old direct links still work as expected.</div>
        </aside>
      </div>
    </div>
  </div>

  <script>
    const state = {
      rootId: ${JSON.stringify(rootId)},
      currentParent: ${JSON.stringify(rootId)},
      parentTrail: [],
      mode: "browse",
      query: "",
      nextPageToken: null,
      lastFiles: []
    };

    const fileGrid = document.getElementById("fileGrid");
    const loadMoreBtn = document.getElementById("loadMoreBtn");
    const breadcrumbsEl = document.getElementById("breadcrumbs");
    const searchInput = document.getElementById("searchInput");
    const statusText = document.getElementById("statusText");
    const sectionTitle = document.getElementById("sectionTitle");
    const activityList = document.getElementById("activityList");
    const previewModal = document.getElementById("previewModal");
    const modalTitle = document.getElementById("modalTitle");
    const modalSubtitle = document.getElementById("modalSubtitle");
    const modalBody = document.getElementById("modalBody");
    const modalDownloadBtn = document.getElementById("modalDownloadBtn");
    const sidebarDownloadBtn = document.getElementById("sidebarDownloadBtn");
    const sidebarOpenBtn = document.getElementById("sidebarOpenBtn");
    const previewName = document.getElementById("previewName");
    const previewType = document.getElementById("previewType");
    const previewMode = document.getElementById("previewMode");

    const statItems = document.getElementById("statItems");
    const statFolders = document.getElementById("statFolders");
    const statPreviewable = document.getElementById("statPreviewable");
    const statSize = document.getElementById("statSize");

    const leftRootLabel = document.getElementById("leftRootLabel");
    const leftModeLabel = document.getElementById("leftModeLabel");

    const storageRing = document.getElementById("storageRing");
    const storagePercent = document.getElementById("storagePercent");
    const storageSub = document.getElementById("storageSub");
    const storageUser = document.getElementById("storageUser");
    const storageUsed = document.getElementById("storageUsed");
    const storageTotal = document.getElementById("storageTotal");
    const storageDrive = document.getElementById("storageDrive");
    const storageTrash = document.getElementById("storageTrash");

    const api = (path) =>
      fetch(path).then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      });

    const formatBytes = (v) => {
      if (!v) return "0 B";
      const u = ["B", "KB", "MB", "GB", "TB"];
      let s = v;
      let i = 0;
      while (s >= 1024 && i < u.length - 1) {
        s /= 1024;
        i++;
      }
      return (s >= 10 || i === 0 ? s.toFixed(0) : s.toFixed(1)) + " " + u[i];
    };

    const formatTime = (v) =>
      v ? new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Unknown";

    const esc = (v) =>
      String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

    const iconFor = (kind, isFolder) =>
      isFolder ? "📁" : ({ image: "🖼️", video: "🎬", audio: "🎵", pdf: "📕", file: "📄" }[kind] || "📄");

    function updateLeftPane() {
      leftModeLabel.textContent =
        state.mode === "search"
          ? "Search"
          : state.mode === "recent"
          ? "Recent"
          : state.mode === "shared"
          ? "Shared"
          : "Browse";

      const current = state.parentTrail[state.parentTrail.length - 1];
      leftRootLabel.textContent = current?.name || "Root";
    }

    function renderStats(files) {
      const folders = files.filter((f) => f.isFolder).length;
      const preview = files.filter((f) => f.inline).length;
      const size = files.reduce((s, f) => s + (f.size || 0), 0);

      statItems.textContent = String(files.length);
      statFolders.textContent = String(folders);
      statPreviewable.textContent = String(preview);
      statSize.textContent = formatBytes(size);
    }

    function renderActivity(files) {
      if (!files.length) {
        activityList.innerHTML = '<div class="item"><div class="item-main"><div class="item-title">No activity yet</div><div class="item-sub">This folder is empty</div></div><div class="item-side">Now</div></div>';
        return;
      }

      const recent = [...files]
        .sort((a, b) => new Date(b.modifiedTime || 0) - new Date(a.modifiedTime || 0))
        .slice(0, 4);

      activityList.innerHTML = recent
        .map(
          (f) =>
            '<div class="item">' +
            '<div class="item-main">' +
            '<div class="item-title">' + iconFor(f.kind, f.isFolder) + ' ' + esc(f.name) + '</div>' +
            '<div class="item-sub">' + (f.isFolder ? 'Folder updated' : formatBytes(f.size || 0)) + '</div>' +
            '</div>' +
            '<div class="item-side">' + formatTime(f.modifiedTime) + '</div>' +
            '</div>'
        )
        .join('');
    }

    function renderBreadcrumbs(items) {
      state.parentTrail = items;
      breadcrumbsEl.innerHTML = items
        .map((i) => '<button class="crumb" data-id="' + i.id + '">' + esc(i.name || 'Root') + '</button>')
        .join('');

      updateLeftPane();

      breadcrumbsEl.querySelectorAll('.crumb').forEach((b) =>
        b.addEventListener('click', () => loadFolder(b.dataset.id, false))
      );
    }

    function createCard(f) {
      const thumb = f.thumbnailLink
        ? '<img src="' + f.thumbnailLink + '" alt="' + esc(f.name) + '">'
        : '<div>' + iconFor(f.kind, f.isFolder) + '</div>';

      const primary = f.isFolder
        ? '<button class="btn btn-pink open-folder" data-id="' + f.id + '">Open</button>'
        : '<button class="btn btn-pink preview-file" data-id="' + f.id + '" data-kind="' + f.kind + '" data-name="' + esc(f.name) + '">Preview</button>';

      const secondary = f.isFolder
        ? '<button class="btn btn-soft open-folder" data-id="' + f.id + '">Browse</button>'
        : '<a class="btn btn-soft" href="/api/file?id=' + encodeURIComponent(f.id) + '&download=1">Download</a>';

      return (
        '<article class="file">' +
        '<div class="thumb">' + thumb + '</div>' +
        '<div class="body">' +
        '<div>' +
        '<div class="name">' + esc(f.name) + '</div>' +
        '<div class="meta">' + (f.isFolder ? 'Folder' : formatBytes(f.size || 0) + ' • ' + formatTime(f.modifiedTime)) + '</div>' +
        '</div>' +
        '<div class="actions">' + primary + secondary + '</div>' +
        '</div>' +
        '</article>'
      );
    }

    function bindCards() {
      document.querySelectorAll('.open-folder').forEach((b) =>
        b.addEventListener('click', () => loadFolder(b.dataset.id, false))
      );

      document.querySelectorAll('.preview-file').forEach((b) =>
        b.addEventListener('click', () => openPreview(b.dataset.id, b.dataset.kind, b.dataset.name))
      );
    }

    function setFiles(files, append = false) {
      state.lastFiles = append ? [...state.lastFiles, ...files] : files;

      renderStats(state.lastFiles);
      renderActivity(state.lastFiles);

      if (!state.lastFiles.length) {
        fileGrid.innerHTML = '<div class="empty">No files found here yet.</div>';
        loadMoreBtn.style.display = 'none';
        return;
      }

      if (append) {
        fileGrid.insertAdjacentHTML('beforeend', files.map(createCard).join(''));
      } else {
        fileGrid.innerHTML = state.lastFiles.map(createCard).join('');
      }

      bindCards();
      loadMoreBtn.style.display = state.nextPageToken ? 'block' : 'none';
    }

    async function loadBreadcrumbs(id) {
      const data = await api('/api/breadcrumbs?id=' + encodeURIComponent(id));
      renderBreadcrumbs(data.items || []);
    }

    async function loadFolder(parentId = state.currentParent, append = false) {
      sectionTitle.textContent =
        state.mode === 'recent' ? 'Recent Files' : state.mode === 'shared' ? 'Shared View' : 'All Files';
      statusText.textContent = append ? 'Loading more items...' : 'Loading folder contents...';

      const target = append ? state.currentParent : parentId;
      const token = append && state.nextPageToken ? '&pageToken=' + encodeURIComponent(state.nextPageToken) : '';
      const data = await api('/api/list?parent=' + encodeURIComponent(target) + token);

      state.currentParent = target;
      state.nextPageToken = data.nextPageToken || null;

      if (!append) await loadBreadcrumbs(target);

      statusText.textContent = (append ? state.lastFiles.length : data.files.length) + ' items ready';
      setFiles(data.files || [], append);
    }

    async function searchFiles(append = false) {
      const q = searchInput.value.trim();
      state.query = q;
      state.mode = q ? 'search' : 'browse';
      activateTab(q ? null : 'browse');
      updateLeftPane();

      if (!q) {
        await loadFolder(state.currentParent, false);
        return;
      }

      sectionTitle.textContent = 'Search Results';
      statusText.textContent = append ? 'Loading more matches...' : 'Searching...';

      const token = append && state.nextPageToken ? '&pageToken=' + encodeURIComponent(state.nextPageToken) : '';
      const data = await api('/api/search?q=' + encodeURIComponent(q) + token);

      state.nextPageToken = data.nextPageToken || null;
      breadcrumbsEl.innerHTML = '<button class="crumb">Search</button>';
      leftRootLabel.textContent = q;
      statusText.textContent = data.files.length + ' matches found';
      setFiles(data.files || [], append);
    }

    function activateTab(mode) {
      document.getElementById('tabBrowse').classList.toggle('active', mode === 'browse');
      document.getElementById('tabRecent').classList.toggle('active', mode === 'recent');
      document.getElementById('tabShared').classList.toggle('active', mode === 'shared');
    }

    function openPreview(id, kind, name) {
      modalTitle.textContent = name || 'Preview';
      const src = '/api/file?id=' + encodeURIComponent(id);
      const downloadSrc = src + '&download=1';
      previewModal.classList.add('open');

      previewName.textContent = name || 'Unknown file';
      previewType.textContent = kind ? kind.toUpperCase() : 'FILE';
      modalSubtitle.textContent = 'Inline preview for ' + (kind || 'file') + ' • ' + name;
      modalDownloadBtn.href = downloadSrc;
      sidebarDownloadBtn.href = downloadSrc;
      sidebarOpenBtn.href = src;

      if (kind === 'image') {
        previewMode.textContent = 'Image viewer';
        modalBody.innerHTML = '<div class="modal-preview-shell"><img src="' + src + '" alt="' + esc(name) + '"></div>';
      } else if (kind === 'video') {
        previewMode.textContent = 'Video player';
        modalBody.innerHTML = '<div class="modal-preview-shell"><video src="' + src + '" controls autoplay playsinline></video></div>';
      } else if (kind === 'audio') {
        previewMode.textContent = 'Audio player';
        modalBody.innerHTML = '<div class="modal-preview-shell" style="padding:32px"><audio src="' + src + '" controls autoplay></audio></div>';
      } else if (kind === 'pdf') {
        previewMode.textContent = 'PDF viewer';
        modalBody.innerHTML = '<div class="modal-preview-shell"><iframe src="' + src + '"></iframe></div>';
      } else {
        previewMode.textContent = 'Download only';
        modalBody.innerHTML =
          '<div class="modal-preview-shell"><div class="preview-fallback">Preview is not available for this file type.<br><br><a class="btn btn-pink" href="' +
          downloadSrc +
          '">Download file</a></div></div>';
      }
    }

    function closePreview() {
      previewModal.classList.remove('open');
      modalBody.innerHTML = '';
    }

    async function loadStorage() {
      try {
        const data = await api('/api/storage');
        const total = Number(data.total || 0);
        const used = Number(data.used || 0);
        const usedInDrive = Number(data.usedInDrive || 0);
        const usedInTrash = Number(data.usedInTrash || 0);
        const pct = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;

        storageRing.style.setProperty('--progress', pct.toFixed(2));
        storagePercent.textContent = pct.toFixed(1) + '%';
        storageSub.textContent = total > 0 ? formatBytes(used) + ' used of ' + formatBytes(total) : 'Storage quota unavailable';
        storageUser.textContent = data.user?.displayName || data.user?.emailAddress || 'Google Drive account';
        storageUsed.textContent = formatBytes(used);
        storageTotal.textContent = total > 0 ? formatBytes(total) : 'Unlimited';
        storageDrive.textContent = formatBytes(usedInDrive);
        storageTrash.textContent = formatBytes(usedInTrash);
      } catch (error) {
        storagePercent.textContent = '--';
        storageSub.textContent = 'Could not load storage';
        storageUser.textContent = 'Check Drive API permissions';
      }
    }

    document.getElementById('homeHeroBtn').addEventListener('click', () => {
      state.mode = 'browse';
      activateTab('browse');
      searchInput.value = '';
      updateLeftPane();
      loadFolder(state.rootId, false);
    });

    document.getElementById('refreshBtn').addEventListener('click', () =>
      state.mode === 'search' ? searchFiles(false) : loadFolder(state.currentParent, false)
    );

    document.getElementById('searchBtn').addEventListener('click', () => searchFiles(false));

    document.getElementById('clearBtn').addEventListener('click', () => {
      searchInput.value = '';
      state.query = '';
      state.mode = 'browse';
      activateTab('browse');
      updateLeftPane();
      loadFolder(state.currentParent, false);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') searchFiles(false);
    });

    document.getElementById('upBtn').addEventListener('click', () => {
      if (state.parentTrail.length > 1) {
        const p = state.parentTrail[state.parentTrail.length - 2];
        loadFolder(p.id, false);
      }
    });

    document.getElementById('tabBrowse').addEventListener('click', () => {
      state.mode = 'browse';
      activateTab('browse');
      updateLeftPane();
      loadFolder(state.currentParent, false);
    });

    document.getElementById('tabRecent').addEventListener('click', async () => {
      state.mode = 'recent';
      activateTab('recent');
      updateLeftPane();
      await loadFolder(state.currentParent, false);
      const sorted = [...state.lastFiles].sort((a, b) => new Date(b.modifiedTime || 0) - new Date(a.modifiedTime || 0));
      sectionTitle.textContent = 'Recent Files';
      statusText.textContent = sorted.length + ' recent items';
      setFiles(sorted, false);
    });

    document.getElementById('tabShared').addEventListener('click', async () => {
      state.mode = 'shared';
      activateTab('shared');
      updateLeftPane();
      await loadFolder(state.currentParent, false);
      const sorted = [...state.lastFiles].sort(
        (a, b) => (b.inline ? 1 : 0) + (b.isFolder ? 1 : 0) - ((a.inline ? 1 : 0) + (a.isFolder ? 1 : 0))
      );
      sectionTitle.textContent = 'Shared View';
      statusText.textContent = 'Optimized for preview-ready items';
      setFiles(sorted, false);
    });

    loadMoreBtn.addEventListener('click', () =>
      state.mode === 'search' ? searchFiles(true) : loadFolder(state.currentParent, true)
    );

    document.getElementById('closeModalBtn').addEventListener('click', closePreview);
    previewModal.addEventListener('click', (e) => {
      if (e.target === previewModal) closePreview();
    });

    updateLeftPane();
    loadStorage();
    loadFolder(state.rootId, false);
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
