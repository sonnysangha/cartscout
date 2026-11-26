// Classic IIFE bundle entry injected into the shop page's isolated world (`autotry.js`).
// Installs one idempotent global (`__cartScoutAutoTry`) shared with the in-page panel.

import { findCodeBox, isSafeApplyControl, isSafeCodeInput } from './finder.js';
import { BUILD } from './limits.js';
import { describeElement, resolvePickPart } from './pick.js';
import { createPageSteps } from './steps.js';
import { isHidden } from './text.js';

if (globalThis.__cartScoutAutoTry?.build !== BUILD) {
  const docId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const steps = createPageSteps({ doc: document, loc: location, docId });

  globalThis.__cartScoutAutoTry = {
    build: BUILD,
    doc: docId,
    ...steps,
    pick: {
      candidates() {
        try {
          return findCodeBox(document, location).scored
            .filter((entry) => !entry.hidden && entry.score >= 25)
            .slice(0, 5)
            .map((entry) => ({
              score: entry.score,
              part: describeElement(entry.field, { kind: 'input' }),
              rect: entry.field.getBoundingClientRect?.() ?? null,
            }))
            .filter((entry) => entry.part);
        } catch {
          return [];
        }
      },
      describe(element, kind = 'input') {
        return describeElement(element, { kind });
      },
      isSafe(element, kind = 'input') {
        return kind === 'apply' ? isSafeApplyControl(element, null) : isSafeCodeInput(element);
      },
      resolve(part, kind = 'input') {
        return resolvePickPart(document, part, { kind });
      },
      rect(element) {
        if (!element || isHidden(element) || typeof element.getBoundingClientRect !== 'function') return null;
        const r = element.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
      },
    },
  };
}
