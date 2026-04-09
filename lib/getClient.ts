/**
 * Fetch a client config from the Supabase `clients` table.
 * This is the single source of truth for client data at runtime —
 * no local file system access, works identically on Vercel and locally.
 */
import { getSupabase } from './supabase';

export interface ClientConfig {
  clientId: string;
  name: string;
  url: string;
  primaryColor: string;
  accentColor: string;
  greeting: string;
  quickReplies: string[];
  content: string;
  logoUrl: string | null;
}

export async function getClientConfig(clientId: string): Promise<ClientConfig | null> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('clients')
      .select('client_id, name, url, primary_color, accent_color, greeting, quick_replies, content, logo_url')
      .eq('client_id', clientId)
      .single();

    if (error || !data) return null;

    return {
      clientId:     data.client_id,
      name:         data.name,
      url:          data.url          ?? '',
      primaryColor: data.primary_color ?? '#2563eb',
      accentColor:  data.accent_color  ?? '#7c3aed',
      greeting:     data.greeting      ?? 'Hi! How can I help you today?',
      quickReplies: (data.quick_replies as string[]) ?? [],
      content:      data.content       ?? '',
      logoUrl:      data.logo_url      ?? null,
    };
  } catch {
    return null;
  }
}
