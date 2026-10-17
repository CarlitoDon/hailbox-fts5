// Routing rules: the first rule (lowest position, then oldest) whose tag or keyword matches wins.
export function matchRule(rules, { subject, body, tags }) {
  const hay = `${subject}\n${body}`.toLowerCase();
  for (const r of rules) {
    const tagOk = r.match_tag == null || tags.includes(r.match_tag);
    const kwOk = r.match_keyword == null || hay.includes(r.match_keyword.toLowerCase());
    if (tagOk && kwOk) return r;
  }
  return null;
}
