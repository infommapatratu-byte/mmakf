// Regression guards for layout defects fixed in Phase 2.
// These assert on the CSS source, so they fail fast if a rule is removed.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/styles/global.css', 'utf8');
const base = readFileSync('src/layouts/Base.astro', 'utf8');

describe('mobile layout guards', () => {
  it('long button labels can wrap on narrow screens (prevented 143px overflow on /about)', () => {
    expect(css).toMatch(/@media \(max-width: 620px\)[\s\S]{0,200}white-space: normal/);
  });

  it('coarse-pointer touch targets are at least 44px', () => {
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]{0,400}min-height: 44px/);
    expect(css).toMatch(/\.nav-hamburger \{ min-width: 44px; min-height: 44px/);
  });

  it('nav bar grows with its content instead of clipping the wordmark', () => {
    expect(base).toMatch(/min-height: 72px/);
    expect(base).not.toMatch(/\.nav-inner \{[^}]*\n\s*height: 72px/);
  });
});

describe('content visibility guards', () => {
  it('scroll-reveal hiding only applies when JS has booted', () => {
    expect(css).toMatch(/\.fade \{ opacity: 1; transform: none; \}/);
    expect(css).toMatch(/html\.js-reveal \.fade \{/);
    expect(base).toMatch(/classList\.add\('js-reveal'\)/);
  });

  it('reveal has a failsafe animation so content cannot stay invisible', () => {
    expect(css).toMatch(/fade-failsafe/);
  });
});

describe('footer contrast guards (P0-4)', () => {
  it('footer uses explicit light values, not the light-theme ink tokens', () => {
    expect(base).toMatch(/\.ft-col a \{[\s\S]{0,120}color: #D8D2C6/);
    expect(base).not.toMatch(/\.ft-col a \{[\s\S]{0,120}var\(--off-white\)/);
  });
});
