'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

export default function EaterPage() {
  const params = useParams();
  const rawCode = params?.code;
  const code = Array.isArray(rawCode) ? rawCode[0] : rawCode;

  const [sessionId, setSessionId] = useState(null);
  const [stalls, setStalls] = useState([]);
  const [availability, setAvailability] = useState({});
  const [q, setQ] = useState('');
  const [chosenId, setChosenId] = useState(null);

  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let availabilityChannel = null;

    async function loadAll() {
      // If for some reason code isn't available yet, don't run queries
      if (!code) return;

      const { data: session, error: sErr } = await supabase
        .from('sessions')
        .select('id, market_id, created_at')
        .eq('code', code.toLowerCase())
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (sErr || !session) {
        console.error('No session found for code', code, sErr);
        return;
      }

      setSessionId(session.id);

      const { data: s } = await supabase
        .from('stalls')
        .select('id, name, banner_url, sort_order')
        .eq('market_id', session.market_id)
        .order('sort_order', { ascending: true });

      setStalls(s || []);

      const { data: a } = await supabase
        .from('availability')
        .select('stall_id, is_open')
        .eq('session_id', session.id);

      const map = {};
      (a || []).forEach((row) => {
        map[row.stall_id] = row.is_open;
      });
      setAvailability(map);

      // persisted choice
      const { data: cc } = await supabase
        .from('current_choice')
        .select('stall_id, request_text')
        .eq('session_id', session.id)
        .maybeSingle();

      if (cc) {
        setChosenId(cc.stall_id ?? null);
        setMessage(cc.request_text ?? '');
      }

      // realtime channel
      availabilityChannel = supabase
        .channel(`availability:${session.id}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'availability',
            filter: `session_id=eq.${session.id}`,
          },
          (payload) => {
            const row = payload.new;
            if (!row) return;
            setAvailability((prev) => ({
              ...prev,
              [row.stall_id]: row.is_open,
            }));
          }
        )
        .subscribe();
    }

    loadAll();

    return () => {
      if (availabilityChannel) {
        supabase.removeChannel(availabilityChannel);
      }
    };
  }, [code]);

  async function sendDishRequest() {
    if (!sessionId) return;
    const text = message.trim();
    if (!text) return;

    try {
      setSending(true);

      await supabase.from('events').insert({
        session_id: sessionId,
        event_type: 'dish_requested',
        meta: { text },
      });

      await supabase
        .from('current_choice')
        .upsert(
          { session_id: sessionId, request_text: text },
          { onConflict: 'session_id' }
        );

      await supabase.channel(`decision:${sessionId}`).send({
        type: 'broadcast',
        event: 'dish_requested',
        payload: { text },
      });

      alert('Request sent ✅');
    } catch (e) {
      console.error('Failed to send dish request', e);
      alert('Could not send request. Try again.');
    } finally {
      setSending(false);
    }
  }

  async function confirmChoice(stall) {
    if (!sessionId) return;

    try {
      await supabase.from('events').insert({
        session_id: sessionId,
        event_type: 'decision_made',
        meta: { stall_id: stall.id, stall_name: stall.name },
      });

      await supabase
        .from('current_choice')
        .upsert(
          { session_id: sessionId, stall_id: stall.id },
          { onConflict: 'session_id' }
        );

      await supabase.channel(`decision:${sessionId}`).send({
        type: 'broadcast',
        event: 'decision_made',
        payload: { stall_id: stall.id, stall_name: stall.name },
      });

      setChosenId(stall.id);
      alert(`You chose: ${stall.name}`);
    } catch (e) {
      console.error('Failed to record decision', e);
      alert('Could not record decision. Try again.');
    }
  }

  const filtered = useMemo(() => {
    const withState = stalls.map((s) => ({
      ...s,
      isOpen: !!availability[s.id],
    }));

    const ordered = withState.sort(
      (a, b) =>
        Number(b.isOpen) - Number(a.isOpen) ||
        (a.sort_order ?? 0) - (b.sort_order ?? 0)
    );

    const term = q.trim().toLowerCase();
    return term
      ? ordered.filter((s) => s.name.toLowerCase().includes(term))
      : ordered;
  }, [stalls, availability, q]);

  return (
    <div style={{ maxWidth: 1024, margin: '0 auto', padding: 12 }}>
      <h1 style={{ fontWeight: 600, fontSize: 20, marginBottom: 8 }}>
        Eater · {code}
      </h1>

      {/* Dish request input */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Type what you want (e.g., duck rice, extra chilli)"
          style={{
            flex: 1,
            padding: 12,
            borderRadius: 12,
            border: '1px solid #ddd',
          }}
        />
        <button
          onClick={sendDishRequest}
          disabled={sending || !message.trim()}
          style={{
            padding: '12px 14px',
            borderRadius: 12,
            border: '1px solid #333',
            background: sending ? '#f3f4f6' : '#111',
            color: sending ? '#666' : '#fff',
          }}
        >
          Send
        </button>
      </div>

      {/* Search bar */}
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search stall…"
        style={{
          width: '100%',
          padding: 12,
          borderRadius: 12,
          border: '1px solid #ddd',
          marginBottom: 8,
        }}
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 12,
        }}
      >
        {filtered.map((stall) => {
          const isOpen = availability[stall.id];
          const isChosen = chosenId === stall.id;

          return (
            <div
              key={stall.id}
              onClick={() => confirmChoice(stall)}
              role="button"
              aria-label={`Choose ${stall.name}`}
              style={{
                cursor: 'pointer',
                border: '2px solid',
                borderColor: isChosen ? '#111' : '#eee',
                borderRadius: 12,
                overflow: 'hidden',
                opacity: isOpen ? 1 : 0.4,
                outline: isChosen ? '2px solid #111' : 'none',
              }}
            >
              <div
                style={{
                  aspectRatio: '3 / 2',
                  background: '#f3f4f6',
                }}
              >
                {stall.banner_url && (
                  <img
                    src={stall.banner_url}
                    alt={stall.name}
                    loading="lazy"
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                    }}
                  />
                )}
              </div>

              <div
                style={{
                  padding: 8,
                  fontSize: 14,
                  fontWeight: 500,
                }}
              >
                {stall.name}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
