export const DEFAULT_JOB_APPLICATION_LABEL = 'Codex Job Applications';

export function gmailLabelSearchTerm(labelName = DEFAULT_JOB_APPLICATION_LABEL) {
  const escaped = String(labelName).replace(/"/g, '\\"');
  return `-label:"${escaped}"`;
}

export async function ensureGmailLabel(gmail, labelName = DEFAULT_JOB_APPLICATION_LABEL) {
  const existing = await gmail.users.labels.list({ userId: 'me' });
  const found = (existing.data.labels || []).find((label) => label.name === labelName);
  if (found?.id) return found.id;

  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name: labelName,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show'
    }
  });
  return created.data.id;
}

export async function moveMessageToGmailLabel(gmail, messageId, labelName = DEFAULT_JOB_APPLICATION_LABEL) {
  const labelId = await ensureGmailLabel(gmail, labelName);
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      addLabelIds: [labelId],
      removeLabelIds: ['INBOX']
    }
  });
  return labelId;
}
