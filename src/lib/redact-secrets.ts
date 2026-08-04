export function redactSecrets(message: string, secrets: Iterable<string>): string {
  const redactionValues = new Set<string>();
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    redactionValues.add(secret);
    redactionValues.add(JSON.stringify(secret).slice(1, -1));
  }

  const orderedSecrets = Array.from(redactionValues).sort((a, b) => b.length - a.length);

  return orderedSecrets.reduce((redacted, secret) => {
    return redacted.split(secret).join("[redacted]");
  }, message);
}
