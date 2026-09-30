/// <reference types="vite/client" />
import type { PasApi } from '../../shared/api'

declare global {
  interface Window {
    pas: PasApi
  }
}
export {}
