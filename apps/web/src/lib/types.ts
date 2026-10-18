export type Role = "student" | "employee" | "admin";

export interface User {
  id: string;
  displayName: string;
  role: Role;
}

export type Persona = User;
export type ResourceKind = 'workplace' | 'meeting_room' | 'lecture_hall' | 'room';

export interface Resource {
  id: string;
  name: string;
  description: string;
  capacity: number | null;
  location: string;
  features: string[];
  serviceId: string;
  /** Missing only in chat cards saved by older clients. */
  kind?: ResourceKind;
  parentId?: string | null;
  parentName?: string | null;
  /** Complete catalog-derived desk count in the parent office, never room seating. */
  officeWorkplaceCount?: number | null;
}

export interface TimeInterval {
  startDate: string;
  endDate: string;
  available: boolean;
}

export interface Booking {
  id: string;
  resourceName: string;
  startDate: string;
  endDate: string;
  status: string;
}

export interface PluginTool {
  name: string;
  title: string;
  effect: "read" | "prepare" | "execute";
}

export interface Plugin {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  healthy: boolean;
  tools: PluginTool[];
}

export type ApiError = Error & { status?: number; code?: string; errors?: { path: string; message: string }[] };
