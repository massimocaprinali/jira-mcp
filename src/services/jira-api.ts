import {
  AddCommentResponse,
  AdfDoc,
  CleanAttachment,
  CleanComment,
  CleanJiraIssue,
  JiraCommentResponse,
  SearchIssuesResponse,
  TM4JTestCase,
  TM4JTestRun,
} from "../types/jira.js";

export class JiraApiService {
  protected baseUrl: string;
  protected headers: Headers;

  constructor(baseUrl: string, email: string, apiToken: string, authType: 'basic' | 'bearer' = 'basic') {
    this.baseUrl = baseUrl;
    
    let authHeader: string;
    if (authType === 'bearer') {
      // For Jira Data Center Personal Access Tokens (PATs)
      authHeader = `Bearer ${apiToken}`;
    } else {
      // For Basic authentication with username/password or API token
      const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
      authHeader = `Basic ${auth}`;
    }
    
    this.headers = new Headers({
      Authorization: authHeader,
      Accept: "application/json",
      "Content-Type": "application/json",
    });
  }

  protected async handleFetchError(
    response: Response,
    url?: string
  ): Promise<never> {
    if (!response.ok) {
      let message = response.statusText;
      let errorData: any = {};
      try {
        errorData = await response.json();

        // Try different error formats that Jira uses
        if (
          Array.isArray(errorData.errorMessages) &&
          errorData.errorMessages.length > 0
        ) {
          // Format: { errorMessages: ["msg1", "msg2"] }
          message = errorData.errorMessages.join("; ");
        } else if (errorData.message) {
          // Format: { message: "error message" }
          message = errorData.message;
        } else if (errorData.errorMessage) {
          // Format: { errorMessage: "error message" }
          message = errorData.errorMessage;
        } else if (errorData.errors && typeof errorData.errors === "object") {
          // Format: { errors: { fieldName: "error for field", anotherField: "another error" } }
          const errorMessages = Object.entries(errorData.errors)
            .map(([field, msg]) => `${field}: ${msg}`)
            .join("; ");
          if (errorMessages) {
            message = errorMessages;
          }
        }

        // If we still only have statusText but have error data, stringify it
        if (message === response.statusText && Object.keys(errorData).length > 0) {
          message = JSON.stringify(errorData);
        }
      } catch (e) {
        // Could not parse as JSON, try to get text
        try {
          const text = await response.text();
          if (text) {
            message = text.substring(0, 500); // Limit length
          }
        } catch {
          // Ignore
        }
      }

      throw new Error(
        `JIRA API Error: ${message} (Status: ${response.status})`
      );
    }

    throw new Error("Unknown error occurred during fetch operation.");
  }

  /**
   * Extracts issue mentions from Atlassian document content
   * Looks for nodes that were auto-converted to issue links
   */
  protected extractIssueMentions(
    content: any[],
    source: "description" | "comment",
    commentId?: string
  ): CleanJiraIssue["relatedIssues"] {
    const mentions: NonNullable<CleanJiraIssue["relatedIssues"]> = [];

    const processNode = (node: any) => {
      if (node.type === "inlineCard" && node.attrs?.url) {
        const match = node.attrs.url.match(/\/browse\/([A-Z]+-\d+)/);
        if (match) {
          mentions.push({
            key: match[1],
            type: "mention",
            source,
            commentId,
          });
        }
      }

      if (node.type === "text" && node.text) {
        const matches = node.text.match(/[A-Z]+-\d+/g) || [];
        matches.forEach((key: string) => {
          mentions.push({
            key,
            type: "mention",
            source,
            commentId,
          });
        });
      }

      if (node.content) {
        node.content.forEach(processNode);
      }
    };

    content.forEach(processNode);
    return [...new Map(mentions.map((m) => [m.key, m])).values()];
  }

  protected cleanComment(comment: {
    id: string;
    body?: {
      content?: any[];
    };
    author?: {
      displayName?: string;
    };
    created: string;
    updated: string;
  }): CleanComment {
    const body = comment.body?.content
      ? this.extractTextContent(comment.body.content)
      : "";
    const mentions = comment.body?.content
      ? this.extractIssueMentions(comment.body.content, "comment", comment.id)
      : [];

    return {
      id: comment.id,
      body,
      author: comment.author?.displayName,
      created: comment.created,
      updated: comment.updated,
      mentions: mentions,
    };
  }

  protected cleanAttachment(attachment: any): CleanAttachment {
    return {
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      created: attachment.created,
      author: attachment.author?.displayName,
      content: attachment.content,
      thumbnail: attachment.thumbnail,
    };
  }

  /**
   * Recursively extracts text content from Atlassian Document Format nodes
   */
  protected extractTextContent(content: any[]): string {
    if (!Array.isArray(content)) return "";

    return content
      .map((node) => {
        if (node.type === "text") {
          return node.text || "";
        }
        if (node.content) {
          return this.extractTextContent(node.content);
        }
        return "";
      })
      .join("");
  }

  protected cleanIssue(issue: any): CleanJiraIssue {
    let description = "";
    if (issue.fields?.description) {
      if (typeof issue.fields.description === "string") {
        // Jira Server: plain text
        description = issue.fields.description;
      } else if (issue.fields.description.content) {
        // Jira Cloud: ADF format
        description = this.extractTextContent(issue.fields.description.content);
      }
    }

    const cleanedIssue: CleanJiraIssue = {
      id: issue.id,
      key: issue.key,
      summary: issue.fields?.summary,
      status: issue.fields?.status?.name,
      created: issue.fields?.created,
      updated: issue.fields?.updated,
      description,
      relatedIssues: [],
    };

    if (issue.fields?.description?.content) {
      const mentions = this.extractIssueMentions(
        issue.fields.description.content,
        "description"
      );
      if (mentions.length > 0) {
        cleanedIssue.relatedIssues = mentions;
      }
    }

    if (issue.fields?.issuelinks?.length > 0) {
      const links = issue.fields.issuelinks.map((link: any) => {
        const linkedIssue = link.inwardIssue || link.outwardIssue;
        const relationship = link.type.inward || link.type.outward;
        return {
          key: linkedIssue.key,
          summary: linkedIssue.fields?.summary,
          type: "link" as const,
          relationship,
          source: "description" as const,
        };
      });

      cleanedIssue.relatedIssues = [
        ...(cleanedIssue.relatedIssues || []),
        ...links,
      ];
    }

    if (issue.fields?.parent) {
      cleanedIssue.parent = {
        id: issue.fields.parent.id,
        key: issue.fields.parent.key,
        summary: issue.fields.parent.fields?.summary,
      };
    }

    if (issue.fields?.customfield_10014) {
      cleanedIssue.epicLink = {
        id: issue.fields.customfield_10014,
        key: issue.fields.customfield_10014,
        summary: undefined,
      };
    }

    if (issue.fields?.subtasks?.length > 0) {
      cleanedIssue.children = issue.fields.subtasks.map((subtask: any) => ({
        id: subtask.id,
        key: subtask.key,
        summary: subtask.fields?.summary,
      }));
    }

    if (issue.fields?.labels?.length > 0) {
      cleanedIssue.labels = issue.fields.labels;
    }

    if (issue.fields?.attachment?.length > 0) {
      cleanedIssue.attachments = issue.fields.attachment.map((a: any) =>
        this.cleanAttachment(a)
      );
    }

    return cleanedIssue;
  }

  protected async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.baseUrl + url, {
      ...init,
      headers: this.headers,
    });

    if (!response.ok) {
      await this.handleFetchError(response, url);
    }

    // Handle 204 No Content - return undefined for void operations (transitions, updates)
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as T;
    }

    return response.json();
  }

  async searchIssues(searchString: string): Promise<SearchIssuesResponse> {
    const params = new URLSearchParams({
      jql: searchString,
      maxResults: "50",
      fields: [
        "id",
        "key",
        "summary",
        "description",
        "status",
        "created",
        "updated",
        "parent",
        "subtasks",
        "customfield_10014",
        "issuelinks",
      ].join(","),
      expand: "names,renderedFields",
    });

    const data = await this.fetchJson<any>(`/rest/api/3/search?${params}`);

    return {
      total: data.total,
      issues: data.issues.map((issue: any) => this.cleanIssue(issue)),
    };
  }

  async getEpicChildren(epicKey: string): Promise<CleanJiraIssue[]> {
    const params = new URLSearchParams({
      jql: `"Epic Link" = ${epicKey}`,
      maxResults: "100",
      fields: [
        "id",
        "key",
        "summary",
        "description",
        "status",
        "created",
        "updated",
        "parent",
        "subtasks",
        "customfield_10014",
        "issuelinks",
      ].join(","),
      expand: "names,renderedFields",
    });

    const data = await this.fetchJson<any>(`/rest/api/3/search?${params}`);

    const issuesWithComments = await Promise.all(
      data.issues.map(async (issue: any) => {
        const commentsData = await this.fetchJson<any>(
          `/rest/api/3/issue/${issue.key}/comment`
        );
        const cleanedIssue = this.cleanIssue(issue);
        const comments = commentsData.comments.map((comment: any) =>
          this.cleanComment(comment)
        );

        const commentMentions = comments.flatMap(
          (comment: CleanComment) => comment.mentions
        );
        cleanedIssue.relatedIssues = [
          ...cleanedIssue.relatedIssues,
          ...commentMentions,
        ];

        cleanedIssue.comments = comments;
        return cleanedIssue;
      })
    );

    return issuesWithComments;
  }

  async getIssueWithComments(issueId: string): Promise<CleanJiraIssue> {
    const params = new URLSearchParams({
      fields: [
        "id",
        "key",
        "summary",
        "description",
        "status",
        "created",
        "updated",
        "parent",
        "subtasks",
        "customfield_10014",
        "issuelinks",
        "attachment",
      ].join(","),
      expand: "names,renderedFields",
    });

    let issueData, commentsData;
    try {
      [issueData, commentsData] = await Promise.all([
        this.fetchJson<any>(`/rest/api/3/issue/${issueId}?${params}`),
        this.fetchJson<any>(`/rest/api/3/issue/${issueId}/comment`),
      ]);
    } catch (error: any) {
      if (error instanceof Error && error.message.includes("(Status: 404)")) {
        throw new Error(`Issue not found: ${issueId}`);
      }

      throw error;
    }

    const issue = this.cleanIssue(issueData);
    const comments = commentsData.comments.map((comment: any) =>
      this.cleanComment(comment)
    );

    const commentMentions = comments.flatMap(
      (comment: CleanComment) => comment.mentions
    );
    issue.relatedIssues = [...issue.relatedIssues, ...commentMentions];

    issue.comments = comments;

    if (issue.epicLink) {
      try {
        const epicData = await this.fetchJson<any>(
          `/rest/api/3/issue/${issue.epicLink.key}?fields=summary`
        );
        issue.epicLink.summary = epicData.fields?.summary;
      } catch (error) {
        console.error("Failed to fetch epic details:", error);
      }
    }

    return issue;
  }

  async createIssue(
    projectKey: string,
    issueType: string,
    summary: string,
    description?: string,
    fields?: Record<string, any>
  ): Promise<{ id: string; key: string }> {
    const payload = {
      fields: {
        project: {
          key: projectKey,
        },
        summary,
        issuetype: {
          name: issueType,
        },
        ...(description && { description }),
        ...fields,
      },
    };

    return this.fetchJson<{ id: string; key: string }>("/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async getCreateMeta(
    projectKey: string,
    issueTypeName?: string,
    compact?: boolean
  ): Promise<any> {
    // Get available issue types for the project
    const issueTypesData = await this.fetchJson<{ issueTypes: Array<{ id: string; name: string; description?: string; subtask: boolean }> }>(
      `/rest/api/3/issue/createmeta/${projectKey}/issuetypes`
    );

    let issueTypes = issueTypesData.issueTypes || [];

    // Filter by issue type name if provided
    if (issueTypeName) {
      issueTypes = issueTypes.filter(
        (it) => it.name.toLowerCase() === issueTypeName.toLowerCase()
      );
    }

    // Get fields for each issue type
    const result = {
      projectKey,
      issueTypes: await Promise.all(
        issueTypes.map(async (issueType) => {
          try {
            const fieldsData = await this.fetchJson<{ fields: Array<{ fieldId: string; name: string; required: boolean; schema?: any; allowedValues?: any[]; hasDefaultValue?: boolean }> }>(
              `/rest/api/3/issue/createmeta/${projectKey}/issuetypes/${issueType.id}`
            );

            let fields = fieldsData.fields || [];

            // In compact mode, replace allowedValues with count
            if (compact) {
              fields = fields.map((f) => ({
                fieldId: f.fieldId,
                name: f.name,
                required: f.required,
                schema: f.schema,
                hasDefaultValue: f.hasDefaultValue,
                allowedValuesCount: f.allowedValues?.length ?? 0,
              }));
            }

            return {
              id: issueType.id,
              name: issueType.name,
              description: issueType.description,
              subtask: issueType.subtask,
              fields,
            };
          } catch (error) {
            return {
              id: issueType.id,
              name: issueType.name,
              description: issueType.description,
              subtask: issueType.subtask,
              fields: [],
              error: error instanceof Error ? error.message : "Failed to fetch fields",
            };
          }
        })
      ),
    };

    return result;
  }

  async getFieldOptions(
    projectKey: string,
    issueTypeId: string,
    fieldId: string
  ): Promise<any[]> {
    const fieldsData = await this.fetchJson<{ fields: Array<{ fieldId: string; allowedValues?: any[] }> }>(
      `/rest/api/3/issue/createmeta/${projectKey}/issuetypes/${issueTypeId}`
    );

    const field = (fieldsData.fields || []).find((f) => f.fieldId === fieldId);
    return field?.allowedValues ?? [];
  }

  async updateIssue(
    issueKey: string,
    fields: Record<string, any>
  ): Promise<void> {
    await this.fetchJson(`/rest/api/3/issue/${issueKey}`, {
      method: "PUT",
      body: JSON.stringify({ fields }),
    });
  }

  async getTransitions(
    issueKey: string
  ): Promise<Array<{ id: string; name: string; to: { name: string } }>> {
    const data = await this.fetchJson<any>(
      `/rest/api/3/issue/${issueKey}/transitions`
    );
    return data.transitions;
  }

  async transitionIssue(
    issueKey: string,
    transitionId: string,
    comment?: string
  ): Promise<void> {
    const payload: any = {
      transition: { id: transitionId },
    };

    if (comment) {
      payload.update = {
        comment: [
          {
            add: {
              body: {
                type: "doc",
                version: 1,
                content: [
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "text",
                        text: comment,
                      },
                    ],
                  },
                ],
              },
            },
          },
        ],
      };
    }

    await this.fetchJson(`/rest/api/3/issue/${issueKey}/transitions`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async addAttachment(
    issueKey: string,
    file: Buffer,
    filename: string
  ): Promise<{ id: string; filename: string }> {
    const formData = new FormData();
    formData.append("file", new Blob([new Uint8Array(file)]), filename);

    const headers = new Headers(this.headers);
    headers.delete("Content-Type");
    headers.set("X-Atlassian-Token", "no-check");

    const response = await fetch(
      `${this.baseUrl}/rest/api/3/issue/${issueKey}/attachments`,
      {
        method: "POST",
        headers,
        body: formData,
      }
    );

    if (!response.ok) {
      await this.handleFetchError(response);
    }

    const data = await response.json();

    const attachment = data[0];
    return {
      id: attachment.id,
      filename: attachment.filename,
    };
  }

  /**
   * Converts plain text to a basic Atlassian Document Format (ADF) structure.
   */
  private createAdfFromBody(text: string): AdfDoc {
    return {
      version: 1,
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: text,
            },
          ],
        },
      ],
    };
  }

  /**
   * Adds a comment to a JIRA issue.
   */
  async addCommentToIssue(
    issueIdOrKey: string,
    body: string
  ): Promise<AddCommentResponse> {
    const adfBody = this.createAdfFromBody(body);

    const payload = {
      body: adfBody,
    };

    const response = await this.fetchJson<JiraCommentResponse>(
      `/rest/api/3/issue/${issueIdOrKey}/comment`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    );

    return {
      id: response.id,
      author: response.author.displayName,
      created: response.created,
      updated: response.updated,
      body: this.extractTextContent(response.body.content),
    };
  }

  async getServerInfo(): Promise<{
    version: string;
    versionNumbers: number[];
    deploymentType: string;
    buildNumber: number;
    serverTitle: string;
  }> {
    return this.fetchJson(`/rest/api/3/serverInfo`);
  }

  async getProjects(): Promise<Array<{
    id: string;
    key: string;
    name: string;
    projectTypeKey: string;
    lead?: { displayName: string; accountId?: string };
  }>> {
    const data = await this.fetchJson<any[]>(`/rest/api/3/project`);
    return data.map((project) => ({
      id: project.id,
      key: project.key,
      name: project.name,
      projectTypeKey: project.projectTypeKey,
      lead: project.lead ? {
        displayName: project.lead.displayName,
        accountId: project.lead.accountId,
      } : undefined,
    }));
  }

  async getUsers(query: string, maxResults: number = 50): Promise<Array<{
    accountId: string;
    displayName: string;
    emailAddress?: string;
    active: boolean;
  }>> {
    const params = new URLSearchParams({
      query,
      maxResults: maxResults.toString(),
    });
    const data = await this.fetchJson<any[]>(`/rest/api/3/user/search?${params}`);
    return data.map((user) => ({
      accountId: user.accountId,
      displayName: user.displayName,
      emailAddress: user.emailAddress,
      active: user.active,
    }));
  }

  async deleteIssue(issueKey: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/rest/api/3/issue/${issueKey}`, {
      method: "DELETE",
      headers: this.headers,
    });

    if (!response.ok) {
      await this.handleFetchError(response);
    }
  }

  async getAttachment(attachmentId: string): Promise<{
    content: string; // base64 encoded
    filename: string;
    mimeType: string;
  }> {
    // First, get attachment metadata to get the content URL
    const metadata = await this.fetchJson<{
      id: string;
      filename: string;
      mimeType: string;
      content: string;
    }>(`/rest/api/3/attachment/${attachmentId}`);

    // Fetch the actual content from the content URL
    const response = await fetch(metadata.content, {
      headers: this.headers,
    });

    if (!response.ok) {
      await this.handleFetchError(response);
    }

    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");

    return {
      content: base64,
      filename: metadata.filename,
      mimeType: metadata.mimeType,
    };
  }

  // ============================================================================
  // TM4J / Zephyr Scale API Methods
  // ============================================================================

  protected tm4jBasePath = '/rest/atm/1.0';

  async getTestCase(testCaseKey: string): Promise<TM4JTestCase> {
    return this.fetchJson<TM4JTestCase>(`${this.tm4jBasePath}/testcase/${testCaseKey}`);
  }

  async searchTestCases(query: string, maxResults = 50): Promise<TM4JTestCase[]> {
    const encodedQuery = encodeURIComponent(query);
    return this.fetchJson<TM4JTestCase[]>(
      `${this.tm4jBasePath}/testcase/search?query=${encodedQuery}&maxResults=${maxResults}`
    );
  }

  async getTestRun(testRunKey: string): Promise<TM4JTestRun> {
    return this.fetchJson<TM4JTestRun>(`${this.tm4jBasePath}/testrun/${testRunKey}`);
  }

  async searchTestRuns(query: string, maxResults = 50): Promise<TM4JTestRun[]> {
    const encodedQuery = encodeURIComponent(query);
    return this.fetchJson<TM4JTestRun[]>(
      `${this.tm4jBasePath}/testrun/search?query=${encodedQuery}&maxResults=${maxResults}`
    );
  }
}
