'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

export default function BuyerPage({ params }) {
  const { code } = params;

  const [sessionId, setSessionId] = useState(null);
  const [stalls, setStalls] = useState([]);
  const [availability, setAvailability] = useState({});

  // Selection + request (persistent)
  const [selectedStallId, setSelectedStallId] = useState(null);
  const [latestRequest, setLatestRequest] = useState(null);

  // Decision timer state
  const [checkedAt, setCheckedAt] = useState(null);
  const [elapsed, setElapsed] = useState(0);

  // Debounce timers per-stall
  const debounceTimersRef = useRef({});

  useEffect(() => {
    let availabilityChannel;
    let decisionChannel;
    let broadcastChannel;
    let choiceChannel;

    async function loadAll() {
      const { data: session } = await supabase
        .from('sessions')
        .select('id, market_id')
        .eq('code', code)
        .single();
      if (!session) return;
      setSessionId(session.id);

      const { data: s } = await supabase
        .from('stalls')
        .select('id, name, banner_url, sort_order, physical_stalls')
        .eq('market_id', session.market_id)
        .order('sort_order', { ascending: true });
      setStalls(s || []);

      const { data: a } = await supabase
        .from('availability')
        .select('stall_id, is_open')
        .eq('session_id', session.id);
      const map = {};
      (a || []).forEach((row) => (map[row.stall_id] = row.is_open));
      setAvailability(map);

      // Load persisted choice/request
      const { data: cc } = await supabase
        .from('current_choice')
        .select('stall_id, request_text')
        .eq('session_id', session.id)
        .maybeSingle();
      if (cc) {
        setSelectedStallId(cc.stall_id ?? null);
        setLatestRequest(cc.request_text ?? null);
      }

      // availability realtime
      availabilityChannel = supabase
        .channel(`availability:${session.id}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'availability', filter: `session_id=eq.${session.id}` },
          (payload) => {
            const row = payload.new;
            if (!row) return;
            setAvailability((prev) => ({ ...prev, [row.stall_id]: row.is_open }));
          }
        )
        .subscribe();

      // events (DB) realtime
      decisionChannel = supabase
        .channel(`events:${session.id}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'events', filter: `session_id=eq.${session.id}` },
          (payload) => {
            const row = payload.new;
            if (!row) return;
            if (row.event_type === 'decision_made') {
              const chosen = row.meta?.stall_name || 'Unknown stall';
              const seconds = checkedAt != null ? Math.floor((Date.now() - checkedAt) / 1000) : null;
              if (seconds != null) console.log('Decision latency (seconds):', seconds);
              alert(`Eater chose: ${chosen}${seconds != null ? `\nDecision time: ${seconds}s` : ''}`);
              setCheckedAt(null);
              setElapsed(0);
              // Also reflect selected stall by name lookup:
              const match = (stalls || []).find((st) => st.name === chosen);
              if (match) setSelectedStallId(match.id);
            }
            if (row.event_type === 'dish_requested') {
              const text = row.meta?.text || '';
              setLatestRequest(text);
            }
          }
        )
        .subscribe();

      // broadcast realtime (instant)
      broadcastChannel = supabase
        .channel(`decision:${session.id}`)
        .on('broadcast', { event: 'decision_made' }, (message) => {
          const chosen = message?.payload?.stall_name || 'Unknown stall';
          const seconds = checkedAt != null ? Math.floor((Date.now() - checkedAt) / 1000) : null;
          if (seconds != null) console.log('Decision latency (seconds):', seconds);
          alert(`Eater chose: ${chosen}${seconds != null ? `\nDecision time: ${seconds}s` : ''}`);
          setCheckedAt(null);
          setElapsed(0);
          const match = (stalls || []).find((st) => st.name === chosen);
          if (match) setSelectedStallId(match.id);
        })
        .on('broadcast', { event: 'dish_requested' }, (message) => {
          const text = message?.payload?.text || '';
          setLatestRequest(text);
        })
        .subscribe();

      // current_choice realtime (persistent single source of truth)
      choiceChannel = supabase
        .channel(`choice:${session.id}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'current_choice', filter: `session_id=eq.${session.id}` },
          (payload) => {
            const row = payload.new;
            if (!row) return;
            setSelectedStallId(row.stall_id ?? null);
            setLatestRequest(row.request_text ?? null);
          }
        )
        .subscribe();
    }

    loadAll();

    return () => {
      if (availabilityChannel) supabase.removeChannel(availabilityChannel);
      if (decisionChannel) supabase.removeChannel(decisionChannel);
      if (broadcastChannel) supabase.removeChannel(broadcastChannel);
      if (choiceChannel) supabase.removeChannel(choiceChannel);
    };
  }, [code, checkedAt, stalls]);

  function toggle(stallId, isOpen) {
    if (!sessionId) return;
    setAvailability((prev) => ({ ...prev, [stallId]: isOpen }));
    const t = debounceTimersRef.current;
    if (t[stallId]) clearTimeout(t[stallId]);
    t[stallId] = setTimeout(async () => {
      try {
        await supabase
          .from('availability')
          .upsert(
            { session_id: sessionId, stall_id: stallId, is_open: isOpen, updated_by: 'buyer' },
            { onConflict: 'session_id,stall_id' }
          );
      } finally {
        delete t[stallId];
      }
    }, 100);
  }

  useEffect(() => {
    if (!checkedAt) return;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - checkedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [checkedAt]);

  async function handleAllStallsChecked() {
    setCheckedAt(Date.now());
    setElapsed(0);
    if (sessionId) {
      await supabase.from('events').insert({ session_id: sessionId, event_type: 'all_checked', meta: {} });
    }
    const eaterLink = window.location.href.replace('/buyer/', '/eater/');
    navigator.share?.({ url: eaterLink }) ?? (window.location.href = eaterLink);
  }

  function stopDecisionTimer() {
    if (!checkedAt) return;
    const seconds = Math.floor((Date.now() - checkedAt) / 1000);
    console.log('Decision latency (seconds):', seconds);
    alert(`Decision latency: ${seconds}s`);
    setCheckedAt(null);
    setElapsed(0);
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 16 }}>
      <h1 style={{ fontWeight: 600, fontSize: 20, marginBottom: 8 }}>Buyer · {code}</h1>

      {/* Persistent selection + request banner */}
      {(selectedStallId || latestRequest) ? (
        <div
          style={{
            margin: '8px 0',
            padding: '10px 12px',
            border: '2px solid #111',
            borderRadius: 12,
            background: '#fafafa',
            lineHeight: 1.35,
          }}
        >
          {selectedStallId ? (
            <div>
              <b>Selected stall:</b>{' '}
              {stalls.find((s) => s.id === selectedStallId)?.name || '—'}
            </div>
          ) : null}
          {latestRequest ? (
            <div>
              <b>Requested:</b> {latestRequest}
            </div>
          ) : null}
        </div>
      ) : null}

      <div style={{ margin: '8px 0', fontSize: 14 }}>
        Open: <b>{Object.values(availability).filter(Boolean).length}</b> / <b>{stalls.length}</b>
      </div>

      <div style={{ position: 'sticky', top: 0, background: 'white', paddingBottom: 8, zIndex: 10 }}>
        <button
          onClick={() => navigator.share?.({ url: window.location.href.replace('/buyer/', '/eater/') })}
          style={{ width: '100%', padding: 12, borderRadius: 12, border: '1px solid #333', fontWeight: 500 }}
        >
          Share Eater link
        </button>
      </div>

      <ul style={{ marginTop: 12 }}>
        {stalls.map((stall) => {
          const isOpen = !!availability[stall.id];
          const isSelected = selectedStallId === stall.id;
          return (
            <li
              key={stall.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 0',
                borderBottom: '1px solid #eee',
                background: isSelected ? '#fffbe6' : 'transparent',
                outline: isSelected ? '2px solid #111' : 'none',
                borderRadius: isSelected ? 8 : 0,
              }}
            >
              <div style={{ paddingRight: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {stall.physical_stalls ? (
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '4px 8px',
                        borderRadius: 999,
                        border: '1px solid #ddd',
                        fontWeight: 600,
                        fontSize: 14,
                        background: '#f8f9fa',
                        minWidth: 44,
                        textAlign: 'center',
                      }}
                      aria-label={`stall number ${stall.physical_stalls}`}
                    >
                      {stall.physical_stalls}
                    </span>
                  ) : null}
                  <span style={{ fontSize: 16 }}>{stall.name}</span>
                </div>
              </div>

              <button
                onClick={() => toggle(stall.id, !isOpen)}
                aria-pressed={isOpen}
                aria-label={`Mark ${stall.name} as ${isOpen ? 'closed' : 'open'}`}
                style={{
                  padding: '8px 14px',
                  borderRadius: 999,
                  border: '1px solid',
                  borderColor: isOpen ? '#6ee7b7' : '#d1d5db',
                  background: isOpen ? '#ecfdf5' : '#f3f4f6',
                }}
              >
                {isOpen ? 'Open' : 'Closed'}
              </button>
            </li>
          );
        })}
      </ul>

      <div style={{ position: 'sticky', bottom: 12, background: 'white', paddingTop: 8 }}>
        {!checkedAt ? (
          <button
            onClick={handleAllStallsChecked}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'center',
              padding: 12,
              borderRadius: 12,
              background: 'black',
              color: 'white',
              border: 'none',
            }}
          >
            ✅ All stalls checked — send to Eater
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1, textAlign: 'center', padding: 12, borderRadius: 12, border: '1px solid #ddd' }}>
              ⏱️ Decision timer: <b>{elapsed}s</b>
            </div>
            <button
              onClick={stopDecisionTimer}
              style={{ padding: 12, borderRadius: 12, background: '#111', color: '#fff', border: 'none' }}
            >
              Stop
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
