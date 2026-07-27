// Mock browser API for tests
if (!(globalThis as any).browser) {
  (globalThis as any).browser = {
    i18n: { getUILanguage: () => 'en' },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: { sendMessage: async () => {} },
  };
}
