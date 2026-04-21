import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CODEX_DIR } from './constants.js';

export interface CodexRotationProfile {
  id: string;
  label: string;
  authPath: string;
}

export interface CodexRotationStatus {
  available: boolean;
  blocker?: string;
  nextAction?: string;
  activeAccount?: string | null;
  activeProfile?: string | null;
  profileCount: number;
  profiles?: CodexRotationProfile[];
}

function codexRoot() {
  return path.join(os.homedir(), CODEX_DIR);
}

function profilesDir() {
  return path.join(codexRoot(), 'profiles');
}

function manifestPath() {
  return path.join(codexRoot(), 'profiles.json');
}

function authPath() {
  return path.join(codexRoot(), 'auth.json');
}

function readJsonIfExists<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function normalizeProfile(raw: unknown, fallbackId: string): CodexRotationProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id : fallbackId;
  const label = typeof obj.label === 'string' ? obj.label : id;
  const authFile = typeof obj.authFile === 'string' ? obj.authFile : typeof obj.authPath === 'string' ? obj.authPath : `${id}.json`;
  return { id, label, authPath: path.isAbsolute(authFile) ? authFile : path.join(profilesDir(), authFile) };
}

export function listCodexRotationProfiles(): CodexRotationProfile[] {
  const manifest = readJsonIfExists<unknown>(manifestPath());
  const fromManifest = Array.isArray(manifest)
    ? manifest.map((entry, index) => normalizeProfile(entry, `profile-${index}`)).filter(Boolean) as CodexRotationProfile[]
    : manifest && typeof manifest === 'object' && Array.isArray((manifest as Record<string, unknown>).profiles)
      ? ((manifest as Record<string, unknown>).profiles as unknown[]).map((entry, index) => normalizeProfile(entry, `profile-${index}`)).filter(Boolean) as CodexRotationProfile[]
      : [];
  if (fromManifest.length > 0) return fromManifest;

  try {
    if (!fs.existsSync(profilesDir())) return [];
    return fs.readdirSync(profilesDir(), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => ({ id: entry.name.replace(/\.json$/, ''), label: entry.name.replace(/\.json$/, ''), authPath: path.join(profilesDir(), entry.name) }));
  } catch {
    return [];
  }
}

function getActiveProfileId(): string | null {
  const active = readJsonIfExists<Record<string, unknown>>(authPath());
  return typeof active?.profile_id === 'string' ? active.profile_id
    : typeof active?.profile === 'string' ? active.profile
    : typeof active?.account_label === 'string' ? active.account_label
    : null;
}

function sanitizeProfileId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'profile';
}

function deriveProfileId(auth: Record<string, unknown>): string {
  const candidate =
    typeof auth.profile_id === 'string' ? auth.profile_id
      : typeof auth.profile === 'string' ? auth.profile
      : typeof auth.account_label === 'string' ? auth.account_label
      : typeof auth.email === 'string' ? auth.email
      : typeof auth.username === 'string' ? auth.username
      : typeof auth.name === 'string' ? auth.name
      : 'profile';
  return sanitizeProfileId(candidate);
}

function deriveProfileLabel(auth: Record<string, unknown>, fallbackId: string): string {
  const candidate =
    typeof auth.account_label === 'string' ? auth.account_label
      : typeof auth.profile_label === 'string' ? auth.profile_label
      : typeof auth.profile_name === 'string' ? auth.profile_name
      : typeof auth.name === 'string' ? auth.name
      : typeof auth.email === 'string' ? auth.email
      : fallbackId;
  return candidate.trim() || fallbackId;
}

function upsertManifestProfile(manifest: unknown, profile: CodexRotationProfile) {
  const entry = {
    id: profile.id,
    label: profile.label,
    authFile: `${profile.id}.json`,
  };

  if (Array.isArray(manifest)) {
    const next = manifest.filter((item) => {
      return !item || typeof item !== 'object' || (item as Record<string, unknown>).id !== profile.id;
    });
    next.push(entry);
    return next;
  }

  if (manifest && typeof manifest === 'object') {
    const record = manifest as Record<string, unknown>;
    const existing = Array.isArray(record.profiles) ? record.profiles : [];
    const profiles = existing.filter((item) => {
      return !item || typeof item !== 'object' || (item as Record<string, unknown>).id !== profile.id;
    });
    profiles.push(entry);
    return { ...record, profiles };
  }

  return { profiles: [entry] };
}

export async function saveCodexProfileFromAuth(input?: { id?: string; label?: string }): Promise<{ ok: boolean; message: string; status: CodexRotationStatus }> {
  const activeAuth = readJsonIfExists<Record<string, unknown>>(authPath());
  if (!activeAuth) {
    return { ok: false, message: 'No active Codex auth snapshot found', status: getCodexRotationStatus() };
  }

  const derivedId = input?.id ? sanitizeProfileId(input.id) : deriveProfileId(activeAuth);
  const id = derivedId || `profile-${Date.now()}`;
  const label = input?.label?.trim() || deriveProfileLabel(activeAuth, id);
  const profile: CodexRotationProfile = { id, label, authPath: path.join(profilesDir(), `${id}.json`) };

  await fs.promises.mkdir(profilesDir(), { recursive: true });
  await writeAtomicJson(profile.authPath, `${JSON.stringify(activeAuth, null, 2)}\n`);

  const manifest = readJsonIfExists<unknown>(manifestPath());
  await writeAtomicJson(manifestPath(), `${JSON.stringify(upsertManifestProfile(manifest, profile), null, 2)}\n`);

  return {
    ok: true,
    message: `Saved ${profile.label} as ${profile.id}`,
    status: getCodexRotationStatus(),
  };
}

export function getCodexRotationStatus(): CodexRotationStatus {
  const profiles = listCodexRotationProfiles();
  if (!profiles.length) {
    return {
      available: false,
      blocker: 'No saved Codex profiles found',
      nextAction: 'Create ~/.codex/profiles.json or ~/.codex/profiles/*.json, then save each account once.',
      activeAccount: null,
      activeProfile: null,
      profileCount: 0,
    };
  }

  const activeId = getActiveProfileId();
  return {
    available: true,
    activeAccount: activeId,
    activeProfile: activeId,
    profileCount: profiles.length,
    profiles,
  };
}

async function writeAtomicJson(file: string, contents: string) {
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await fs.promises.writeFile(tmp, contents, 'utf8');
  await fs.promises.rename(tmp, file);
}

export async function rotateCodexAuth(targetId?: string): Promise<{ ok: boolean; message: string; status: CodexRotationStatus }> {
  const profiles = listCodexRotationProfiles();
  if (!profiles.length) {
    return { ok: false, message: 'No saved profiles available', status: getCodexRotationStatus() };
  }

  const currentAuth = authPath();
  const activeProfileId = getActiveProfileId();
  const currentProfile = activeProfileId ? profiles.find((profile) => profile.id === activeProfileId) : null;
  if (currentProfile && fs.existsSync(currentAuth)) {
    await fs.promises.copyFile(currentAuth, currentProfile.authPath).catch(() => undefined);
  }

  const nextProfile = targetId
    ? profiles.find((profile) => profile.id === targetId)
    : profiles.find((profile) => profile.id !== currentProfile?.id) ?? profiles[0];
  if (!nextProfile) {
    return { ok: false, message: 'Target profile not found', status: getCodexRotationStatus() };
  }

  const tmp = `${currentAuth}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.copyFile(nextProfile.authPath, tmp);
  await fs.promises.rename(tmp, currentAuth);
  return { ok: true, message: `Switched to ${nextProfile.label}`, status: getCodexRotationStatus() };
}
