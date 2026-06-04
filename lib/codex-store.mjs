import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { roleKey } from './codex-role.mjs';

export async function loadStore(policy, { root = process.cwd() } = {}) {
  const file = path.join(root, policy.storage.applicationsPath);
  if (!existsSync(file)) {
    return { version: 1, applications: [], runs: [] };
  }
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function saveStore(store, policy, { root = process.cwd() } = {}) {
  const file = path.join(root, policy.storage.applicationsPath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(store, null, 2));
}

export function findDuplicate(store, role) {
  const key = roleKey(role);
  return (store.applications || []).find((app) => app.roleKey === key || app.role?.id === role.id) || null;
}

export function upsertApplication(store, record) {
  const key = record.roleKey;
  const idx = store.applications.findIndex((app) => app.roleKey === key || app.role?.id === record.role?.id);
  if (idx >= 0) {
    store.applications[idx] = {
      ...store.applications[idx],
      ...record,
      history: [...(store.applications[idx].history || []), ...(record.history || [])]
    };
  } else {
    store.applications.push(record);
  }
  return record;
}

export async function saveRunSummary(summary, policy, { root = process.cwd() } = {}) {
  const dir = path.join(root, policy.storage.runsDir);
  await mkdir(dir, { recursive: true });
  const stamp = summary.startedAt.replace(/[:.]/g, '-');
  const file = path.join(dir, `run-${stamp}.json`);
  await writeFile(file, JSON.stringify(summary, null, 2));
  return file;
}
