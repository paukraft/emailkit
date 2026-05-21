export type DomainDNSRecord = {
  type: string;
  name: string;
  value: string;
  ttl?: number | "auto";
  priority?: number;
  purpose?: string;
  verified?: boolean;
};

export type DomainVerification = {
  status: string;
  records: DomainDNSRecord[];
  checkedAt?: string;
};

export type SandboxDomain = {
  id: string;
  name: string;
  status: string;
  region?: string;
  createdAt?: string;
  verification?: DomainVerification;
};
