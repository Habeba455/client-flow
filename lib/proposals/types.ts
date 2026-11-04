export interface ProposalTable {
  headers: string[];
  rows: string[][];
}

export interface ProposalBullet {
  title: string;
  detail: string;
}

export interface ProposalDocumentData {
  solutionName: string;
  solutionSubtitle: string;
  executiveSummary: string[];
  challengeIntro: string;
  challengePoints: ProposalBullet[];
  solutionOverview: string[];
  architectureTable: ProposalTable;
  keyCapabilities: ProposalBullet[];
  workflowTransformationTitle: string;
  workflowTransformationIntro: string;
  workflowTable: ProposalTable;
  technicalApproachTitle: string;
  integrationTable: ProposalTable;
  implementationSteps: string[];
  securityControls: ProposalBullet[];
  roadmapIntro: string;
  roadmapTable: ProposalTable;
  roadmapNote: string;
  investmentIntro: string;
  investmentTable: ProposalTable;
  investmentNote: string;
  whyUs: ProposalBullet[];
  nextStepsIntro: string;
  nextSteps: string[];
}

export interface StoredProposalRecord {
  id: string;
  user_id: string;
  title: string;
  pdf_path: string;
  json_path: string;
  pdf_data: Buffer | null;
  json_payload: Record<string, unknown> | null;
  created_at: string;
}
