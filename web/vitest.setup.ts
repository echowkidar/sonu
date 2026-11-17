import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
class RO { observe() {} unobserve() {} disconnect() {} }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= RO;

// jsdom has no layout: give elements the size their inline style asks for so virtual lists can measure.
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return parseFloat((this as HTMLElement).style.height) || 0; } });
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return parseFloat((this as HTMLElement).style.width) || 800; } });
