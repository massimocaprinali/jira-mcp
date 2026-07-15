export interface CleanComment {
  id: string;
  body: string;
  author: string | undefined;
  created: string;
  updated: string;
  mentions: NonNullable<CleanJiraIssue["relatedIssues"]>;
}

export interface CleanJiraIssue {
  id: string;
  key: string;
  summary: string | undefined;
  status: string | undefined;
  created: string | undefined;
  updated: string | undefined;
  description: string;
  labels?: string[];
  attachments?: CleanAttachment[];
  comments?: CleanComment[];
  parent?: {
    id: string;
    key: string;
    summary?: string;
  };
  children?: {
    id: string;
    key: string;
    summary?: string;
  }[];
  epicLink?: {
    id: string;
    key: string;
    summary?: string;
  };
  relatedIssues: {
    key: string;
    summary?: string;
    type: "mention" | "link";
    relationship?: string; // For formal issue links e.g. "blocks", "relates to"
    source: "description" | "comment";
    commentId?: string;
  }[];
}

export interface SearchIssuesResponse {
  total: number;
  issues: CleanJiraIssue[];
}

// Basic Atlassian Document Format (ADF) structure for a simple paragraph
export interface AdfDoc {
  version: 1;
  type: "doc";
  content: AdfNode[];
}

export type AdfNodeType = "paragraph" | "text"; // Add other types as needed

export interface AdfNode {
  type: AdfNodeType;
  content?: AdfNode[];
  text?: string;
}

// Response structure from JIRA API after adding a comment
export interface JiraCommentResponse {
  id: string;
  self: string; // URL to the comment
  author: {
    displayName: string;
    // ... other author details
  };
  body: AdfDoc; // JIRA returns the comment body in ADF
  created: string;
  updated: string;
  // ... other fields
}

// Cleaned response for the MCP tool
export interface AddCommentResponse {
  id: string;
  author: string;
  created: string;
  updated: string;
  body: string; // Return plain text for simplicity
}

export interface CleanAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  created: string;
  author?: string;
  content: string;
  thumbnail?: string;
}

export interface TM4JTestCase {
  key: string;
  name: string;
  status?: string;
  priority?: string;
  objective?: string;
  precondition?: string;
  estimatedTime?: number;
  labels?: string[];
  folder?: string;
  projectKey?: string;
  [key: string]: any;
}

export interface TM4JTestRun {
  key: string;
  name: string;
  status?: string;
  projectKey?: string;
  testCases?: Array<{
    testCaseKey: string;
    status?: string;
  }>;
  [key: string]: any;
}
