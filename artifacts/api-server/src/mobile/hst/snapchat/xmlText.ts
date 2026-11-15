export function decodeXmlText(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, name: string) => {
    const normalizedName = name.toLowerCase();
    if (normalizedName === "amp") return "&";
    if (normalizedName === "lt") return "<";
    if (normalizedName === "gt") return ">";
    if (normalizedName === "quot") return '"';
    if (normalizedName === "apos") return "'";

    const codePoint = normalizedName.startsWith("#x")
      ? Number.parseInt(normalizedName.slice(2), 16)
      : Number.parseInt(normalizedName.slice(1), 10);
    if (
      !Number.isInteger(codePoint) ||
      codePoint < 0 ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return entity;
    }
    return String.fromCodePoint(codePoint);
  });
}
