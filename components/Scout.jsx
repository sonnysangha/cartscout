'use client';

import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { mountScout, setMood } from '@/extension/scout.js';

export function Scout({ mood = 'idle', tile = false, sticker = false, size, label = '', className = '', ...rest }) {
  const ref = useRef(null);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    mountScout(ref.current, { mood, tile, sticker, label });
    mounted.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (mounted.current && ref.current && ref.current.dataset.mood !== mood) {
      setMood(ref.current, mood);
    }
  }, [mood]);

  const names = ['scout', tile && 'scout-tile', sticker && 'scout-sticker', className].filter(Boolean).join(' ');
  return (
    <span
      ref={ref}
      className={names}
      style={size ? { '--scout-size': size } : undefined}
      role={label ? 'img' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : 'true'}
      {...rest}
    />
  );
}
