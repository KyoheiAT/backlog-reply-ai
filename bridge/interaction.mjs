// Conversation is client-supplied context, not a persistent model session.
// Keep it bounded independently of the main issue and tool context.
export function validInteraction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['phase', 'messages'].includes(key))
    || !['discuss', 'draft'].includes(value.phase) || !Array.isArray(value.messages)
    || value.messages.length > 20) return false;
  let total = 0;
  for (const message of value.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || Object.keys(message).some(key => !['role', 'text'].includes(key))
      || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string'
      || !message.text.trim() || message.text.length > 4000) return false;
    total += message.text.length;
    if (total > 24000) return false;
  }
  return true;
}
