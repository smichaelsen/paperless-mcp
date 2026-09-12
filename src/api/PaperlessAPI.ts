import {
  errorClass,
  logRequestFailure,
  normalizeEndpoint,
  registerSecret,
} from "../logging";

/**
 * Read and discard a response body. Failed responses must still be drained so
 * the connection can be reused — but the payload is never inspected or logged,
 * because it carries document titles, content and permissions.
 */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.text();
  } catch {
    // Nothing to do — the body is being thrown away either way.
  }
}

export class PaperlessAPI {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {
    this.baseUrl = baseUrl;
    this.token = token;
    // Belt and braces: even if the token ends up inside some third-party error
    // message, the logger will scrub it.
    registerSecret(token);
  }

  /**
   * Perform a request, returning only successful responses. Failures are logged
   * as redacted operational metadata — method, normalized endpoint class,
   * status, duration and error class. The URL, headers, request body and
   * Paperless response body are never logged.
   */
  private async fetchWithLogging(
    method: string,
    endpointPath: string,
    url: string,
    init: RequestInit
  ): Promise<Response> {
    const endpoint = normalizeEndpoint(endpointPath);
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      logRequestFailure({
        method,
        endpoint,
        durationMs: Date.now() - startedAt,
        errorClass: errorClass(error),
      });
      // Neither the URL nor the original error is carried along: both can embed
      // a credential, and this message reaches the MCP client verbatim.
      throw new Error(`Paperless request failed: ${method} ${endpoint}`);
    }

    if (!response.ok) {
      logRequestFailure({
        method,
        endpoint,
        status: response.status,
        durationMs: Date.now() - startedAt,
        errorClass: "HttpStatusError",
      });
      await discardBody(response);
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return response;
  }

  async request(path: string, options: RequestInit = {}) {
    const url = `${this.baseUrl}/api${path}`;
    const headers = {
      Authorization: `Token ${this.token}`,
      Accept: "application/json; version=9",
      "Content-Type": "application/json",
      "Accept-Language": "en-US,en;q=0.9",
    };

    const method = (options.method ?? "GET").toUpperCase();
    const response = await this.fetchWithLogging(method, path, url, {
      ...options,
      headers: {
        ...headers,
        ...options.headers,
      },
    });

    return response.json();
  }

  // Document operations
  async bulkEditDocuments(documents, method, parameters = {}) {
    return this.request("/documents/bulk_edit/", {
      method: "POST",
      body: JSON.stringify({
        documents,
        method,
        parameters,
      }),
    });
  }

  async postDocument(
    file: File,
    metadata: Record<string, string | string[]> = {}
  ) {
    const formData = new FormData();
    formData.append("document", file);

    // Add optional metadata fields
    if (metadata.title) formData.append("title", metadata.title);
    if (metadata.created) formData.append("created", metadata.created);
    if (metadata.correspondent)
      formData.append("correspondent", metadata.correspondent);
    if (metadata.document_type)
      formData.append("document_type", metadata.document_type);
    if (metadata.storage_path)
      formData.append("storage_path", metadata.storage_path);
    if (metadata.tags) {
      (metadata.tags as string[]).forEach((tag) =>
        formData.append("tags", tag)
      );
    }
    if (metadata.archive_serial_number) {
      formData.append("archive_serial_number", metadata.archive_serial_number);
    }
    if (metadata.custom_fields) {
      (metadata.custom_fields as string[]).forEach((field) =>
        formData.append("custom_fields", field)
      );
    }

    const path = "/documents/post_document/";
    const response = await this.fetchWithLogging(
      "POST",
      path,
      `${this.baseUrl}/api${path}`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${this.token}`,
        },
        body: formData,
      }
    );

    return response.json();
  }

  async getDocuments(query = "") {
    return this.request(`/documents/${query}`);
  }

  async getDocument(id) {
    return this.request(`/documents/${id}/`);
  }

  async updateDocument(id: number, data: Record<string, any>) {
    return this.request(`/documents/${id}/`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async searchDocuments(query, page?, pageSize?) {
    const params = new URLSearchParams();
    params.set("query", query);
    if (page) params.set("page", page.toString());
    if (pageSize) params.set("page_size", pageSize.toString());
    
    const response: any = await this.request(`/documents/?${params.toString()}`);
    
    // Filter out content field and long URLs to reduce token usage
    if (response.results) {
      response.results = response.results.map((doc: any) => {
        const { content, download_url, thumbnail_url, ...rest } = doc;
        return {
          ...rest,
          // Include only document ID for constructing URLs if needed
          id: doc.id,
        };
      });
    }
    
    return response;
  }

  async downloadDocument(id, asOriginal = false) {
    const query = asOriginal ? "?original=true" : "";
    const path = `/documents/${id}/download/`;
    const response = await this.fetchWithLogging(
      "GET",
      path,
      `${this.baseUrl}/api${path}${query}`,
      {
        headers: {
          Authorization: `Token ${this.token}`,
        },
      }
    );

    return response;
  }

  // Tag operations
  async getTags(query = "") {
    return this.request(`/tags/${query}`);
  }

  async getTag(id) {
    return this.request(`/tags/${id}/`);
  }

  async createTag(data) {
    return this.request("/tags/", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateTag(id, data) {
    return this.request(`/tags/${id}/`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async deleteTag(id) {
    return this.request(`/tags/${id}/`, {
      method: "DELETE",
    });
  }

  // Correspondent operations
  async getCorrespondents(query = "") {
    return this.request(`/correspondents/${query}`);
  }

  async getCorrespondent(id) {
    return this.request(`/correspondents/${id}/`);
  }

  async createCorrespondent(data) {
    return this.request("/correspondents/", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // Document type operations
  async getDocumentTypes(query = "") {
    return this.request(`/document_types/${query}`);
  }

  async getDocumentType(id) {
    return this.request(`/document_types/${id}/`);
  }

  async createDocumentType(data) {
    return this.request("/document_types/", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // Bulk object operations
  async bulkEditObjects(objects, objectType, operation, parameters = {}) {
    return this.request("/bulk_edit_objects/", {
      method: "POST",
      body: JSON.stringify({
        objects,
        object_type: objectType,
        operation,
        ...parameters,
      }),
    });
  }
}
