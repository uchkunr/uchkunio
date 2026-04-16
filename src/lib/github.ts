const API = "https://api.github.com";
const OWNER = "uchkunr";
const REPO = "uchkunio";

function headers() {
  const token = import.meta.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export interface GHFile {
  path: string;
  name: string;
  sha: string;
  content: string;
}

export async function getFile(path: string): Promise<GHFile> {
  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${path}`);
  const data = await res.json();
  return {
    path: data.path,
    name: data.name,
    sha: data.sha,
    content: decodeURIComponent(escape(atob(data.content.replace(/\n/g, "")))),
  };
}

export async function listDir(path: string): Promise<Omit<GHFile, "content">[]> {
  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${path}`);
  const data: any[] = await res.json();
  return data
    .filter((f) => f.type === "file")
    .map((f) => ({ path: f.path, name: f.name, sha: f.sha }));
}

export async function saveFile(
  path: string,
  content: string,
  sha: string | undefined,
  message: string
): Promise<void> {
  const encoded = btoa(unescape(encodeURIComponent(content)));
  const body: Record<string, string> = { message, content: encoded };
  if (sha) body.sha = sha;

  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`GitHub ${res.status}: ${err.message ?? path}`);
  }
}

export async function deleteFile(path: string, sha: string, message: string): Promise<void> {
  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    method: "DELETE",
    headers: headers(),
    body: JSON.stringify({ message, sha }),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${path}`);
}
