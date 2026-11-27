export function personalizeGoogleChromeDmMessage(message: string, displayName: string): string {
  const firstName = displayName.trim().split(/\s+/u)[0] ?? "";
  if (!firstName && /\[FIRSTNAME\]/i.test(message)) {
    throw new Error("The selected Facebook profile has no usable first name.");
  }
  return message.replace(/\[FIRSTNAME\]/gi, () => firstName);
}
