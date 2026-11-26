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

export const clerkLocalization = {
  signIn: { start: { subtitle: 'Welcome back.' } },
  signUp: { start: { subtitle: '5 free shop scans a week.' } },
};
