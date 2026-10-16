export type Role = "student" | "employee" | "admin";

export type User = {
  id: string;
  displayName: string;
  role: Role;
};

export type Persona = User;

export type Resource = {
  id: string;
  name: string;
  description: string;
  capacity: number | null;
  location: string;
  features: string[];
  serviceId: string;
};

export type TimeInterval = {
  startDate: string;
  endDate: string;
  available: boolean;
};

export type Booking = {
  id: string;
  resourceName: string;
  startDate: string;
  endDate: string;
  status: string;
};

export type PluginTool = {
  name: string;
  title: string;
  effect: "read" | "prepare" | "execute";
};

export type Plugin = {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  healthy: boolean;
  tools: PluginTool[];
};

export type ApiError = Error & { status?: number };
