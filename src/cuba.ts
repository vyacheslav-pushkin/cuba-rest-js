import {
  EntitiesWithCount,
  EntityMessages,
  EnumInfo,
  MetaClassInfo,
  PermissionInfo, RolesInfo,
  SerializedEntity,
  UserInfo,
  View
} from "./model";
import {DefaultStorage} from "./storage";
import {EntityFilter} from "./filter";
import {base64encode, encodeGetParams} from "./util";

export * from './model';
export * from './storage';
export * from './filter';

const apps: CubaApp[] = [];

/**
 * Initializes app.
 * @param {AppConfig} config
 * @returns {CubaApp}
 */
export function initializeApp(config: AppConfig = {}): CubaApp {
  if (getApp(config.name) != null) {
    throw new Error("Cuba app is already initialized");
  }
  const cubaApp = new CubaApp(config.name, config.apiUrl, config.restClientId, config.restClientSecret,
    config.defaultLocale, config.storage);
  apps.push(cubaApp);
  return cubaApp;
}

/**
 * Retrieve previously initialized app by name.
 * @param {string} appName
 * @returns {CubaApp | null}
 */
export function getApp(appName?: string): CubaApp | null {
  const nameToSearch = appName == null ? "" : appName;
  for (const app of apps) {
    if (app.name === nameToSearch) {
      return app;
    }
  }
  return null;
}

export function removeApp(appName?: string): void {
  const app = getApp(appName);
  if (!app) {
    throw new Error('App is not found');
  }
  app.cleanup();
  apps.splice(apps.indexOf(app), 1);
}

export interface AppConfig {
  apiUrl?: string;
  name?: string;
  restClientId?: string;
  restClientSecret?: string;
  defaultLocale?: string;
  storage?: Storage;
}

export interface ResponseError extends Error {
  response?: any;
}

export type ContentType = "text" | "json" | "blob" | "raw";

export interface FetchOptions extends RequestInit {
  handleAs?: ContentType;
}

export interface EntitiesLoadOptions {
  view?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

export interface LoginOptions {
  tokenEndpoint: string;
}

export class CubaApp {

  private static REST_TOKEN_STORAGE_KEY = "cubaAccessToken";
  private static USER_NAME_STORAGE_KEY = "cubaUserName";
  private static LOCALE_STORAGE_KEY = "cubaLocale";

  public messagesCache: EntityMessages;
  public enumsCache: EnumInfo[];

  private tokenExpiryListeners: Array<(() => {})> = [];
  private messagesLoadingListeners: Array<((messages: EntityMessages) => {})> = [];
  private enumsLoadingListeners: Array<((enums: any[]) => {})> = [];
  private localeChangeListeners: Array<((locale: string) => {})> = [];

  constructor(public name = "",
              public apiUrl = "/app/rest/",
              public restClientId = "client",
              public restClientSecret = "secret",
              public defaultLocale = "en",
              private storage: Storage = new DefaultStorage()) {
  }

  get restApiToken(): string {
    return this.storage.getItem(this.name + "_" + CubaApp.REST_TOKEN_STORAGE_KEY);
  }

  set restApiToken(token: string) {
    this.storage.setItem(this.name + "_" + CubaApp.REST_TOKEN_STORAGE_KEY, token);
  }

  get locale(): string {
    const storedLocale = this.storage.getItem(this.name + "_" + CubaApp.LOCALE_STORAGE_KEY);
    return storedLocale ? storedLocale : this.defaultLocale;
  }

  set locale(locale: string) {
    this.storage.setItem(this.name + "_" + CubaApp.LOCALE_STORAGE_KEY, locale);
    this.localeChangeListeners.forEach((l) => l(this.locale));
  }

  /**
   * Logs in user and stores token in provided storage.
   * @param {string} login
   * @param {string} password
   * @param {LoginOptions} options You can use custom endpoints e.g. {tokenEndpoint:'ldap/token'}.
   * @returns {Promise<{access_token: string}>}
   */
  public login(login: string, password: string, options?: LoginOptions): Promise<{ access_token: string }> {
    if (login == null) {
      login = "";
    }
    if (password == null) {
      password = "";
    }
    const fetchOptions = {
      method: "POST",
      headers: this._getBasicAuthHeaders(),
      body: "grant_type=password&username=" + encodeURIComponent(login) + "&password=" + encodeURIComponent(password),
    };
    const endpoint = options && options.tokenEndpoint ? options.tokenEndpoint : 'oauth/token';
    const loginRes = fetch(this.apiUrl + "v2/" + endpoint, fetchOptions)
      .then(this.checkStatus)
      .then((resp) => resp.json())
      .then((data) => {
        this.restApiToken = data.access_token;
        return data;
      });
    return loginRes;
  }

  public logout(): Promise<any> {
    return this.revokeToken(this.restApiToken);
  }

  public revokeToken(token: string): Promise<any> {
    const fetchOptions = {
      method: 'POST',
      headers: this._getBasicAuthHeaders(),
      body: 'token=' + encodeURIComponent(token),
    };
    this.clearAuthData();
    return fetch(this.apiUrl + 'v2/oauth/revoke', fetchOptions).then(this.checkStatus);
  }

  public loadEntities<T>(
    entityName: string,
    options?: EntitiesLoadOptions,
    fetchOptions?: FetchOptions
  ): Promise<Array<SerializedEntity<T>>> {
    return this.fetch('GET', 'v2/entities/' + entityName, options, {handleAs: 'json', ...fetchOptions});
  }

  public loadEntitiesWithCount<T>(
    entityName: string,
    options?: EntitiesLoadOptions,
    fetchOptions?: FetchOptions
  ): Promise<EntitiesWithCount<T>> {
    let count;
    const optionsWithCount = {...options, returnCount: true};
    return this.fetch('GET', `v2/entities/${entityName}`, optionsWithCount, {handleAs: 'raw', ...fetchOptions})
      .then((response: Response) => {
        count = parseInt(response.headers.get('X-Total-Count'), 10);
        return response.json();
      }).then((result: Array<SerializedEntity<T>>) => ({result, count}));
  }

  public searchEntities<T>(
    entityName: string,
    entityFilter: EntityFilter,
    options?: EntitiesLoadOptions,
    fetchOptions?: FetchOptions
  ): Promise<Array<SerializedEntity<T>>> {
    const data = {...options, filter: entityFilter};
    return this.fetch('GET', 'v2/entities/' + entityName + '/search', data, {handleAs: 'json', ...fetchOptions});
  }

  public searchEntitiesWithCount<T>(
    entityName: string,
    entityFilter: EntityFilter,
    options?: EntitiesLoadOptions,
    fetchOptions?: FetchOptions
  ): Promise<EntitiesWithCount<T>> {
    let count;
    const optionsWithCount = {...options, filter: entityFilter, returnCount: true};
    return this.fetch(
        'GET',
        'v2/entities/' + entityName + '/search',
        optionsWithCount,
        { handleAs: 'raw', ...fetchOptions }
      ).then((response: Response) => {
        count = parseInt(response.headers.get('X-Total-Count'), 10);
        return response.json();
      }).then((result: Array<SerializedEntity<T>>) => ({result, count}));
  }

  public loadEntity<T>(
    entityName: string,
    id,
    options?: { view?: string },
    fetchOptions?: FetchOptions
  ): Promise<SerializedEntity<T>> {
    return this.fetch('GET', 'v2/entities/' + entityName + '/' + id, options, {handleAs: 'json', ...fetchOptions});
  }

  public deleteEntity(entityName: string, id, fetchOptions?: FetchOptions): Promise<void> {
    return this.fetch('DELETE', 'v2/entities/' + entityName + '/' + id, null, fetchOptions);
  }

  public commitEntity<T extends {id?: string}>(
    entityName: string,
    entity: T,
    fetchOptions?: FetchOptions
  ): Promise<Partial<T>> {
    if (entity.id) {
      return this.fetch('PUT', 'v2/entities/' + entityName + '/' + entity.id, JSON.stringify(entity),
        {handleAs: 'json', ...fetchOptions});
    } else {
      return this.fetch('POST', 'v2/entities/' + entityName, JSON.stringify(entity),
        {handleAs: 'json', ...fetchOptions});
    }
  }

  public invokeService<T>(
    serviceName: string,
    methodName: string,
    params: any,
    fetchOptions?: FetchOptions
  ): Promise<T> {
    const serializedParams = params != null ? JSON.stringify(params) : null;
    return this.fetch('POST', 'v2/services/' + serviceName + '/' + methodName, serializedParams, fetchOptions);
  }

  public query<T>(
    entityName: string,
    queryName: string,
    params?: any,
    fetchOptions?: FetchOptions
  ): Promise<Array<SerializedEntity<T>>> {
    return this.fetch('GET', 'v2/queries/' + entityName + '/' + queryName, params, {handleAs: 'json', ...fetchOptions});
  }

  public queryWithCount<T>(entityName: string, queryName: string, params?: any,
                           fetchOptions?: FetchOptions): Promise<EntitiesWithCount<T>> {
    let count;
    const paramsWithCount = {...params, returnCount: true};
    return this.fetch('GET', `v2/queries/${entityName}/${queryName}`, paramsWithCount,
      {handleAs: 'raw', ...fetchOptions})
      .then((response: Response) => {
        count = parseInt(response.headers.get('X-Total-Count'), 10);
        return response.json();
      })
      .then((result: Array<SerializedEntity<T>>) => ({result, count}));
  }

  public queryCount(entityName: string, queryName: string, params?: any, fetchOptions?: FetchOptions): Promise<number> {
    return this.fetch('GET', 'v2/queries/' + entityName + '/' + queryName + '/count', params, fetchOptions);
  }

  public loadMetadata(fetchOptions?: FetchOptions): Promise<MetaClassInfo[]> {
    return this.fetch('GET', 'v2/metadata/entities', null, {handleAs: 'json', ...fetchOptions});
  }

  public loadEntityMetadata(entityName: string, fetchOptions?: FetchOptions): Promise<MetaClassInfo> {
    return this.fetch('GET', 'v2/metadata/entities' + '/' + entityName, null, {handleAs: 'json', ...fetchOptions});
  }

  public loadEntityViews(entityName: string, fetchOptions?: FetchOptions): Promise<View[]> {
    return this.fetch('GET', 'v2/metadata/entities/' + entityName + '/views', null,
      {handleAs: 'json', ...fetchOptions});
  }

  public loadEntityView(entityName: string, viewName: string, fetchOptions?: FetchOptions): Promise<View> {
    return this.fetch('GET', 'v2/metadata/entities/' + entityName + '/views/' + viewName + '/', null,
      {handleAs: 'json', ...fetchOptions});
  }

  public loadEntitiesMessages(fetchOptions?: FetchOptions): Promise<EntityMessages> {
    const fetchRes = this.fetch<EntityMessages>('GET', 'v2/messages/entities', null,
      {handleAs: 'json', ...fetchOptions});
    fetchRes.then((messages) => {
      this.messagesCache = messages;
      this.messagesLoadingListeners.forEach((l) => l(messages));
    });
    return fetchRes;
  }

  public loadEnums(fetchOptions?: FetchOptions): Promise<EnumInfo[]> {
    const fetchRes = this.fetch<EnumInfo[]>('GET', 'v2/metadata/enums', null, {handleAs: 'json', ...fetchOptions});
    fetchRes.then((enums) => {
      this.enumsCache = enums;
      this.enumsLoadingListeners.forEach((l) => l(enums));
    });
    return fetchRes;
  }

  public getPermissions(fetchOptions?: FetchOptions): Promise<PermissionInfo[]> {
    return this.fetch('GET', 'v2/permissions', null, {handleAs: 'json', ...fetchOptions});
  }

  public getRoles(fetchOptions?: FetchOptions): Promise<RolesInfo> {
    return this.fetch('GET', 'v2/roles', null, {handleAs: 'json', ...fetchOptions});
  }

  public getUserInfo(fetchOptions?: FetchOptions): Promise<UserInfo> {
    return this.fetch('GET', 'v2/userInfo', null, {handleAs: 'json', ...fetchOptions});
  }

  public getFileUploadURL(): string {
    return this.apiUrl + 'v2/files';
  }

  public getFile(id: string, fetchOptions?: FetchOptions): Promise<Blob> {
    return this.fetch('GET', 'v2/files/' + id, null, {handleAs: 'blob', ...fetchOptions});
  }

  public fetch<T>(method: string, path: string, data?: any, fetchOptions?: FetchOptions): Promise<T> {
    let url = this.apiUrl + path;
    const settings: FetchOptions = {
      method,
      headers: {
        "Accept-Language": this.locale,
      },
      ...fetchOptions,
    };
    if (this.restApiToken) {
      settings.headers["Authorization"] = "Bearer " + this.restApiToken;
    }
    if (method === 'POST' || method === 'PUT') {
      settings.body = data;
      settings.headers["Content-Type"] = "application/json; charset=UTF-8";
    }
    if (method === 'GET' && data && Object.keys(data).length > 0) {
      url += '?' + encodeGetParams(data);
    }
    const handleAs: ContentType = fetchOptions ? fetchOptions.handleAs : undefined;
    switch (handleAs) {
      case "text":
        settings.headers["Accept"] = "text/html";
        break;
      case "json":
        settings.headers["Accept"] = "application/json";
        break;
    }

    const fetchRes = fetch(url, settings).then(this.checkStatus);

    fetchRes.catch((error) => {
      if (this.isTokenExpiredResponse(error.response)) {
        this.clearAuthData();
        this.tokenExpiryListeners.forEach((l) => l());
      }
    });

    return fetchRes.then((resp) => {

      if (resp.status === 204) {
        return resp.text();
      }

      switch (handleAs) {
        case "text":
          return resp.text();
        case "blob":
          return resp.blob();
        case "json":
          return resp.json();
        case "raw":
          return resp;
        default:
          return resp.text();
      }
    });
  }

  public onLocaleChange(c) {
    this.localeChangeListeners.push(c);
    return () => this.localeChangeListeners.splice(this.localeChangeListeners.indexOf(c), 1);
  }

  public onTokenExpiry(c) {
    this.tokenExpiryListeners.push(c);
    return () => this.tokenExpiryListeners.splice(this.tokenExpiryListeners.indexOf(c), 1);
  }

  public onEnumsLoaded(c) {
    this.enumsLoadingListeners.push(c);
    return () => this.enumsLoadingListeners.splice(this.enumsLoadingListeners.indexOf(c), 1);
  }

  public onMessagesLoaded(c) {
    this.messagesLoadingListeners.push(c);
    return () => this.messagesLoadingListeners.splice(this.messagesLoadingListeners.indexOf(c), 1);
  }

  public cleanup() {
    this.storage.clear();
  }

  public setSessionLocale(): Promise<void> {
    return this.fetch('PUT', 'v2/user-session/locale');
  }

  private isTokenExpiredResponse(resp: Response): boolean {
    return resp && resp.status === 401;
    // && resp.responseJSON
    // && resp.responseJSON.error === 'invalid_token';
  }

  private _getBasicAuthHeaders(): { [header: string]: string } {
    return getBasicAuthHeaders(this.restClientId, this.restClientSecret, this.locale);
  }

  private checkStatus(response: Response): any {
    if (response.status >= 200 && response.status < 300) {
      return response;
    } else {
      return Promise.reject({message: response.statusText, response});
    }
  }

  private clearAuthData(): void {
    this.storage.removeItem(this.name + "_" + CubaApp.REST_TOKEN_STORAGE_KEY);
    this.storage.removeItem(this.name + "_" + CubaApp.USER_NAME_STORAGE_KEY);
  }

}

export function getBasicAuthHeaders(client: string, secret: string, locale = 'en'): { [header: string]: string } {
  return {
    "Accept-Language": locale,
    "Authorization": "Basic " + base64encode(client + ':' + secret),
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  };
}
