export interface AppConfig {
  backendBaseUrl: string;
  webAppBaseUrl: string;
}

export function getConfig(): AppConfig {
  return {
    backendBaseUrl: 'http://localhost:8080',
    webAppBaseUrl: 'http://localhost:5173'
  };
}
