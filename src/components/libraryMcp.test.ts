// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createComponent, type Component } from 'solid-js';
import { render } from 'solid-js/web';
import type { LibraryMcpStatus } from '../bindings/LibraryMcpStatus';
import { libraryMcp } from '../platform/libraryMcp';
import { startLibraryMcpStatus } from '../platform/libraryMcpStatus';
import { dialogStore, openDialog } from '../store/dialogStore';
import { libraryMcpStore } from '../store/libraryMcpStore';
import { LibraryMcpIndicator } from './LibraryMcpIndicator';
import { LibraryMcpModal } from './panels/LibraryMcpModal';

const URL = 'http://127.0.0.1:8793/mcp';
const OFF: LibraryMcpStatus = { enabled: false, running: false, url: URL, token: null, error: null };
const ON: LibraryMcpStatus = { enabled: true, running: true, url: URL, token: 'tok-1', error: null };
const TAKEN: LibraryMcpStatus = { ...ON, running: false, error: 'Port 8793 is in use' };

const listeners: ((status: LibraryMcpStatus) => void)[] = [];
vi.mock('../platform/libraryMcp', () => ({
  libraryMcp: {
    status: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    rotateToken: vi.fn(),
    listen: vi.fn((handler: (status: LibraryMcpStatus) => void) => {
      listeners.push(handler);
      return () => listeners.splice(listeners.indexOf(handler), 1);
    }),
  },
}));
const mocked = vi.mocked(libraryMcp);
const writeText = vi.fn(async () => {});
Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

let dispose: (() => void) | undefined;
function mount(component: Component) {
  const host = document.body.appendChild(document.createElement('div'));
  dispose = render(() => createComponent(component, {}), host);
  return host;
}
const settle = () => new Promise((r) => setTimeout(r));
const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
const toggle = (host: HTMLElement) => host.querySelector<HTMLInputElement>('.library-mcp__toggle')!;
const values = (host: HTMLElement) => [...host.querySelectorAll('.library-mcp__value code')].map((c) => c.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  libraryMcpStore.setState({ status: OFF });
  openDialog({ libraryMcp: true });
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

test('the toggle enables and disables, showing the URL and token only while on', async () => {
  mocked.enable.mockResolvedValue(ON);
  mocked.disable.mockResolvedValue({ ...OFF, token: null });
  const host = mount(LibraryMcpModal);
  expect(values(host)).toEqual([]);

  toggle(host).click();
  expect(toggle(host).checked).toBe(false);
  await settle();
  expect(mocked.enable).toHaveBeenCalledTimes(1);
  expect(toggle(host).checked).toBe(true);
  expect(values(host)).toEqual([URL, 'tok-1']);

  toggle(host).click();
  await settle();
  expect(mocked.disable).toHaveBeenCalledTimes(1);
  expect(values(host)).toEqual([]);
});

test('copy puts the value on the clipboard, and rotate shows the new token', async () => {
  libraryMcpStore.setState({ status: ON });
  mocked.rotateToken.mockResolvedValue({ ...ON, token: 'tok-2' });
  const host = mount(LibraryMcpModal);

  const [, copyToken] = [...host.querySelectorAll<HTMLButtonElement>('.library-mcp__value button')];
  copyToken.click();
  await settle();
  expect(writeText).toHaveBeenCalledWith('tok-1');
  expect(copyToken.textContent).toBe('Copied');

  button(host, 'Rotate token').click();
  await settle();
  expect(mocked.rotateToken).toHaveBeenCalledTimes(1);
  expect(values(host)).toEqual([URL, 'tok-2']);
});

test('a failed start shows its error, and Retry enables again', async () => {
  libraryMcpStore.setState({ status: TAKEN });
  mocked.enable.mockResolvedValue(ON);
  const host = mount(LibraryMcpModal);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Port 8793 is in use');

  button(host, 'Retry').click();
  await settle();
  expect(mocked.enable).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test('a command that fails leaves the toggle where it was and says why', async () => {
  mocked.enable.mockRejectedValue(new Error('database is locked'));
  const host = mount(LibraryMcpModal);
  toggle(host).click();
  await settle();
  expect(toggle(host).checked).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('database is locked');
});

test('Escape closes the dialog', () => {
  mount(LibraryMcpModal);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(dialogStore.getState().libraryMcp).toBe(false);
});

test('the indicator takes the status at startup, follows changes, and opens the dialog', async () => {
  libraryMcpStore.setState({ status: null });
  dialogStore.setState({ libraryMcp: false });
  mocked.status.mockResolvedValue(ON);
  const stop = startLibraryMcpStatus();
  const host = mount(LibraryMcpIndicator);
  expect(host.querySelector('.mcp-indicator')).toBeNull();

  await settle();
  const pill = () => host.querySelector<HTMLButtonElement>('.mcp-indicator');
  expect(pill()?.textContent).toBe('MCP on');

  listeners.forEach((l) => l(TAKEN));
  expect(pill()?.textContent).toBe('MCP stopped');
  expect(pill()?.classList.contains('is-error')).toBe(true);
  expect(pill()?.title).toBe('Port 8793 is in use');

  pill()!.click();
  expect(dialogStore.getState().libraryMcp).toBe(true);

  listeners.forEach((l) => l(OFF));
  expect(pill()).toBeNull();
  stop();
  expect(listeners).toEqual([]);
});

test('an event that lands before the startup status wins over it', async () => {
  libraryMcpStore.setState({ status: null });
  let answer!: (status: LibraryMcpStatus) => void;
  mocked.status.mockReturnValue(new Promise((r) => (answer = r)));
  const stop = startLibraryMcpStatus();
  listeners.forEach((l) => l(ON));
  answer(OFF);
  await settle();
  expect(libraryMcpStore.getState().status).toEqual(ON);
  stop();
});
