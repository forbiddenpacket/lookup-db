import test from "node:test";
import assert from "node:assert/strict";
import { validateSupabaseCredentials } from "./connectionValidation.js";

test("requires a project URL before Supabase schema discovery", () => {
  assert.equal(validateSupabaseCredentials({ key: "public-key" }), "Supabase project URL is required.");
});

test("requires an API key before Supabase schema discovery", () => {
  assert.equal(validateSupabaseCredentials({ url: "https://example.supabase.co" }), "Supabase API key is required.");
});

test("accepts complete Supabase credentials", () => {
  assert.equal(validateSupabaseCredentials({ url: " https://example.supabase.co/ ", key: " public-key " }), null);
});
