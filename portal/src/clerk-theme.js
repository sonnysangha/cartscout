// Clerk's components, dressed in the CartScout brand. Colours are our CSS custom properties, so Clerk follows
// the light and dark themes from extension/brand.css without a second palette. Shape and the pressable yellow
// button are finished in style.css against Clerk's stable `cl-` classes; `cssLayerName` puts Clerk's own rules in
// a cascade layer so ours win without `!important`.
//
// `colorPrimary` is ink, not yellow: Clerk also uses the primary colour for link text and small accents, and
// yellow text fails contrast on a light canvas. The solid primary button is painted yellow with ink text directly.
export const clerkAppearance = {
  cssLayerName: 'clerk',
  options: { elevation: 'flush', logoPlacement: 'none' },
  variables: {
    colorPrimary: 'var(--ink)',
    colorPrimaryForeground: 'var(--canvas)',
    colorForeground: 'var(--ink)',
    colorMutedForeground: 'var(--muted)',
    colorBackground: 'var(--canvas)',
    colorMuted: 'var(--surface)',
    colorNeutral: 'var(--ink)',
    colorInput: 'var(--canvas)',
    colorInputForeground: 'var(--ink)',
    colorBorder: 'var(--ink)',
    colorRing: 'var(--focus)',
    colorShadow: 'transparent',
    colorDanger: 'var(--red)',
    colorSuccess: 'var(--green)',
    colorShimmer: 'var(--fill-strong)',
    colorModalBackdrop: 'var(--on-sun)',
    fontFamily: 'var(--font-ui)',
    fontFamilyButtons: 'var(--font-ui)',
    fontFamilyMono: 'var(--font-code)',
    fontSize: '0.9375rem',
    fontWeight: { normal: 600, medium: 700, semibold: 800, bold: 900 },
    borderRadius: '0.625rem',
  },
};

// Clerk's stock greetings repeat the page heading and shout. These say one plain thing each.
export const clerkLocalization = {
  signIn: { start: { subtitle: 'Welcome back.' } },
  signUp: { start: { subtitle: '5 free shop scans a week.' } },
};
