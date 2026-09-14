/** Context windows, as documented by the providers at the time of writing. `--window` overrides. */
export function windowFor(model: string | undefined): { tokens: number; assumed: boolean } {
  const m = (model ?? "").toLowerCase();
  if (/claude/.test(m)) return { tokens: 200_000, assumed: false };
  if (/^(gpt-5|o[1-9])/.test(m)) return { tokens: 400_000, assumed: false };
  if (/gpt-4\.1/.test(m)) return { tokens: 1_000_000, assumed: false };
  if (/gpt-4o|gpt-4-turbo/.test(m)) return { tokens: 128_000, assumed: false };
  return { tokens: 200_000, assumed: true };
}
