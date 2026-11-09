export function validateSupabaseCredentials(credentials) {
  if (!String(credentials?.url ?? "").trim()) return "Supabase project URL is required.";
  if (!String(credentials?.key ?? "").trim()) return "Supabase API key is required.";
  return null;
}
