import type {
  ConnectionInfo,
  DataService,
  ConnectionStorage,
  connect,
} from 'mongodb-data-service';
import { getConnectionTitle } from 'mongodb-data-service';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { cloneDeep } from 'lodash';
import { v4 as uuidv4 } from 'uuid';
import type { ConnectionAttempt } from '../modules/connection-attempt';
import { createConnectionAttempt } from '../modules/connection-attempt';
import {
  trackConnectionAttemptEvent,
  trackNewConnectionEvent,
  trackConnectionFailedEvent,
} from '../modules/telemetry';
import ConnectionString from 'mongodb-connection-string-url';
import { adjustConnectionOptionsBeforeConnect } from '@mongodb-js/connection-form';
import { useToast } from '@mongodb-js/compass-components';
import { createLoggerAndTelemetry } from '@mongodb-js/compass-logging';

const { debug, mongoLogId, log } = createLoggerAndTelemetry(
  'COMPASS-CONNECTIONS'
);

type ConnectFn = typeof connect;

export type { ConnectFn };

export function createNewConnectionInfo(): ConnectionInfo {
  return {
    id: uuidv4(),
    connectionOptions: {
      connectionString: 'mongodb://localhost:27017',
    },
  };
}

function isOIDCAuth(connectionString: string): boolean {
  const authMechanismString = (
    new ConnectionString(connectionString).searchParams.get('authMechanism') ||
    ''
  ).toUpperCase();

  return authMechanismString === 'MONGODB-OIDC';
}

function ensureWellFormedConnectionString(connectionString: string) {
  new ConnectionString(connectionString);
}

type State = {
  activeConnectionId?: string;
  activeConnectionInfo: ConnectionInfo;
  connectingStatusText: string;
  connectionAttempt: ConnectionAttempt | null;
  connectionErrorMessage: string | null;
  connections: ConnectionInfo[];
  oidcDeviceAuthVerificationUrl: string | null;
  oidcDeviceAuthUserCode: string | null;
};

export function defaultConnectionsState(): State {
  return {
    activeConnectionId: undefined,
    activeConnectionInfo: createNewConnectionInfo(),
    connectingStatusText: '',
    connections: [],
    connectionAttempt: null,
    connectionErrorMessage: null,
    oidcDeviceAuthVerificationUrl: null,
    oidcDeviceAuthUserCode: null,
  };
}

type Action =
  | {
      type: 'attempt-connect';
      connectionAttempt: ConnectionAttempt;
      connectingStatusText: string;
    }
  | {
      type: 'oidc-attempt-connect-notify-device-auth';
      verificationUrl: string;
      userCode: string;
    }
  | {
      type: 'cancel-connection-attempt';
    }
  | {
      type: 'connection-attempt-errored';
      connectionErrorMessage: string;
    }
  | {
      type: 'connection-attempt-succeeded';
    }
  | {
      type: 'new-connection';
      connectionInfo: ConnectionInfo;
    }
  | {
      type: 'set-active-connection';
      connectionInfo: ConnectionInfo;
    }
  | {
      type: 'set-connections';
      connections: ConnectionInfo[];
    }
  | {
      type: 'set-connections-and-select';
      connections: ConnectionInfo[];
      activeConnectionInfo: ConnectionInfo;
    };

export function connectionsReducer(state: State, action: Action): State {
  switch (action.type) {
    case 'attempt-connect':
      return {
        ...state,
        connectionAttempt: action.connectionAttempt,
        connectingStatusText: action.connectingStatusText,
        connectionErrorMessage: null,
        oidcDeviceAuthVerificationUrl: null,
        oidcDeviceAuthUserCode: null,
      };
    case 'cancel-connection-attempt':
      return {
        ...state,
        connectionAttempt: null,
        connectionErrorMessage: null,
      };
    case 'connection-attempt-succeeded':
      return {
        ...state,
        connectionAttempt: null,
        connectionErrorMessage: null,
      };
    case 'connection-attempt-errored':
      return {
        ...state,
        connectionAttempt: null,
        connectionErrorMessage: action.connectionErrorMessage,
      };
    case 'oidc-attempt-connect-notify-device-auth':
      return {
        ...state,
        oidcDeviceAuthVerificationUrl: action.verificationUrl,
        oidcDeviceAuthUserCode: action.userCode,
      };
    case 'set-active-connection':
      return {
        ...state,
        activeConnectionId: action.connectionInfo.id,
        activeConnectionInfo: action.connectionInfo,
        connectionErrorMessage: null,
      };
    case 'new-connection':
      return {
        ...state,
        activeConnectionId: action.connectionInfo.id,
        activeConnectionInfo: action.connectionInfo,
        connectionErrorMessage: null,
      };
    case 'set-connections':
      return {
        ...state,
        connections: action.connections,
        connectionErrorMessage: null,
      };
    case 'set-connections-and-select':
      return {
        ...state,
        connections: action.connections,
        activeConnectionId: action.activeConnectionInfo.id,
        activeConnectionInfo: action.activeConnectionInfo,
        connectionErrorMessage: null,
      };
    default:
      return state;
  }
}

async function loadConnections(
  dispatch: React.Dispatch<{
    type: 'set-connections';
    connections: ConnectionInfo[];
  }>,
  connectionStorage: ConnectionStorage
) {
  try {
    const loadedConnections = await connectionStorage.loadAll();

    dispatch({
      type: 'set-connections',
      connections: loadedConnections,
    });
  } catch (error) {
    debug('error loading connections', error);
  }
}

const MAX_RECENT_CONNECTIONS_LENGTH = 10;
export function useConnections({
  onConnected,
  isConnected,
  connectionStorage,
  appName,
  getAutoConnectInfo,
  connectFn,
}: {
  onConnected: (
    connectionInfo: ConnectionInfo,
    dataService: DataService
  ) => void;
  isConnected: boolean;
  connectionStorage: ConnectionStorage;
  getAutoConnectInfo?: () => Promise<ConnectionInfo | undefined>;
  connectFn: ConnectFn;
  appName: string;
}): {
  state: State;
  recentConnections: ConnectionInfo[];
  favoriteConnections: ConnectionInfo[];
  cancelConnectionAttempt: () => void;
  connect: (
    connectionInfo: ConnectionInfo | (() => Promise<ConnectionInfo>)
  ) => Promise<void>;
  createNewConnection: () => void;
  saveConnection: (connectionInfo: ConnectionInfo) => Promise<void>;
  setActiveConnectionById: (newConnectionId: string) => void;
  removeAllRecentsConnections: () => Promise<void>;
  duplicateConnection: (connectioInfo: ConnectionInfo) => void;
  removeConnection: (connectionInfo: ConnectionInfo) => void;
  reloadConnections: () => void;
} {
  const { openToast } = useToast('compass-connections');

  const [state, dispatch]: [State, React.Dispatch<Action>] = useReducer(
    connectionsReducer,
    defaultConnectionsState()
  );
  const { activeConnectionId, connectionAttempt, connections } = state;

  const connectingConnectionAttempt = useRef<ConnectionAttempt>();

  const { recentConnections, favoriteConnections } = useMemo(() => {
    const favoriteConnections = (state.connections || [])
      .filter((connectionInfo) => !!connectionInfo.favorite)
      .sort((a, b) => {
        const aName = a.favorite?.name?.toLocaleLowerCase() || '';
        const bName = b.favorite?.name?.toLocaleLowerCase() || '';
        return bName < aName ? 1 : -1;
      });

    const recentConnections = (state.connections || [])
      .filter((connectionInfo) => !connectionInfo.favorite)
      .sort((a, b) => {
        const aTime = a.lastUsed?.getTime() ?? 0;
        const bTime = b.lastUsed?.getTime() ?? 0;
        return bTime - aTime;
      });

    return { recentConnections, favoriteConnections };
  }, [state.connections]);

  async function saveConnectionInfo(
    connectionInfo: ConnectionInfo
  ): Promise<boolean> {
    try {
      ensureWellFormedConnectionString(
        connectionInfo?.connectionOptions?.connectionString
      );
      await connectionStorage.save(connectionInfo);
      debug(`saved connection with id ${connectionInfo.id || ''}`);

      return true;
    } catch (err) {
      debug(
        `error saving connection with id ${connectionInfo.id || ''}: ${
          (err as Error).message
        }`
      );

      openToast('save-connection-error', {
        title: 'Error',
        variant: 'warning',
        description: `An error occurred while saving the connection. ${
          (err as Error).message
        }`,
      });

      return false;
    }
  }

  async function removeConnection(connectionInfo: ConnectionInfo) {
    await connectionStorage.delete(connectionInfo);
    dispatch({
      type: 'set-connections',
      connections: connections.filter((conn) => conn.id !== connectionInfo.id),
    });
    if (activeConnectionId === connectionInfo.id) {
      const nextActiveConnection = createNewConnectionInfo();
      dispatch({
        type: 'set-active-connection',
        connectionInfo: nextActiveConnection,
      });
    }
  }

  const onConnectSuccess = useCallback(
    async (
      connectionInfo: ConnectionInfo,
      dataService: DataService,
      shouldSaveConnectionInfo: boolean
    ) => {
      try {
        onConnected(connectionInfo, dataService);

        if (!shouldSaveConnectionInfo) return;

        // if a connection has been saved already we only want to update the lastUsed
        // attribute, otherwise we are going to save the entire connection info.
        const connectionInfoToBeSaved =
          (await connectionStorage.load(connectionInfo.id)) ?? connectionInfo;

        await saveConnectionInfo({
          ...cloneDeep(connectionInfoToBeSaved),
          lastUsed: new Date(),
        });

        // Remove the oldest recent connection if are adding a new one and
        // there are already MAX_RECENT_CONNECTIONS_LENGTH recents.
        // NOTE: there are edge cases that may lead to more than
        // MAX_RECENT_CONNECTIONS_LENGTH to be saved (ie. concurrent run
        // of Compass), however we accept it as long as the list of
        // recent connections won't grow indefinitely.
        if (
          !connectionInfoToBeSaved.favorite &&
          !connectionInfoToBeSaved.lastUsed &&
          recentConnections.length >= MAX_RECENT_CONNECTIONS_LENGTH
        ) {
          await connectionStorage.delete(
            recentConnections[recentConnections.length - 1]
          );
        }
      } catch (err) {
        debug(
          `error occurred connection with id ${connectionInfo.id || ''}: ${
            (err as Error).message
          }`
        );
      }
    },
    [onConnected, connectionStorage, saveConnectionInfo, removeConnection]
  );

  useEffect(() => {
    // Load connections after first render.
    void loadConnections(dispatch, connectionStorage);

    if (getAutoConnectInfo) {
      log.info(
        mongoLogId(1_001_000_160),
        'Connection Store',
        'Performing automatic connection attempt'
      );
      void connect(getAutoConnectInfo);
    }

    return () => {
      // When unmounting, clean up any current connection attempts that have
      // not resolved.
      if (
        connectingConnectionAttempt.current &&
        !connectingConnectionAttempt.current.isClosed()
      ) {
        connectingConnectionAttempt.current.cancelConnectionAttempt();
      }
    };
  }, [getAutoConnectInfo]);

  const connect = async (
    getAutoConnectInfo:
      | ConnectionInfo
      | (() => Promise<ConnectionInfo | undefined>)
  ) => {
    if (connectionAttempt || isConnected) {
      // Ensure we aren't currently connecting.
      return;
    }

    const newConnectionAttempt = createConnectionAttempt(connectFn);
    connectingConnectionAttempt.current = newConnectionAttempt;

    let connectionInfo: ConnectionInfo | undefined = undefined;
    let shouldSaveConnectionInfo = false;
    try {
      if (typeof getAutoConnectInfo === 'function') {
        connectionInfo = await getAutoConnectInfo();
        if (!connectionInfo) {
          connectingConnectionAttempt.current = undefined;
          return;
        }

        dispatch({
          type: 'set-active-connection',
          connectionInfo,
        });
      } else {
        connectionInfo = getAutoConnectInfo;
        shouldSaveConnectionInfo = true;
      }

      const isOIDCConnectionAttempt = isOIDCAuth(
        connectionInfo.connectionOptions.connectionString
      );
      dispatch({
        type: 'attempt-connect',
        connectingStatusText: `Connecting to ${getConnectionTitle(
          connectionInfo
        )}${
          isOIDCConnectionAttempt
            ? '. Go to the browser to complete authentication.'
            : ''
        }`,
        connectionAttempt: newConnectionAttempt,
      });

      trackConnectionAttemptEvent(connectionInfo);
      debug('connecting with connectionInfo', connectionInfo);

      let notifyDeviceFlow:
        | ((deviceFlowInformation: {
            verificationUrl: string;
            userCode: string;
          }) => void)
        | undefined;
      if (isOIDCConnectionAttempt) {
        notifyDeviceFlow = (deviceFlowInformation: {
          verificationUrl: string;
          userCode: string;
        }) => {
          dispatch({
            type: 'oidc-attempt-connect-notify-device-auth',
            verificationUrl: deviceFlowInformation.verificationUrl,
            userCode: deviceFlowInformation.userCode,
          });
        };
      }

      const newConnectionDataService = await newConnectionAttempt.connect(
        adjustConnectionOptionsBeforeConnect({
          connectionOptions: connectionInfo.connectionOptions,
          defaultAppName: appName,
          notifyDeviceFlow,
        })
      );
      connectingConnectionAttempt.current = undefined;

      if (!newConnectionDataService || newConnectionAttempt.isClosed()) {
        // The connection attempt was cancelled.
        return;
      }

      dispatch({
        type: 'connection-attempt-succeeded',
      });

      void onConnectSuccess(
        connectionInfo,
        newConnectionDataService,
        shouldSaveConnectionInfo
      );

      trackNewConnectionEvent(connectionInfo, newConnectionDataService);
      debug(
        'connection attempt succeeded with connection info',
        connectionInfo
      );
    } catch (error) {
      connectingConnectionAttempt.current = undefined;
      if (connectionInfo) {
        trackConnectionFailedEvent(connectionInfo, error as Error);
      }
      log.error(
        mongoLogId(1_001_000_161),
        'Connection Store',
        'Error performing connection attempt',
        {
          error: (error as Error).message,
        }
      );

      dispatch({
        type: 'connection-attempt-errored',
        connectionErrorMessage: (error as Error).message,
      });
    }
  };

  return {
    state,
    recentConnections,
    favoriteConnections,
    cancelConnectionAttempt() {
      connectionAttempt?.cancelConnectionAttempt();

      dispatch({
        type: 'cancel-connection-attempt',
      });
    },
    connect,
    createNewConnection() {
      dispatch({
        type: 'new-connection',
        connectionInfo: createNewConnectionInfo(),
      });
    },
    async saveConnection(connectionInfo: ConnectionInfo) {
      const saved = await saveConnectionInfo(connectionInfo);

      if (!saved) {
        return;
      }

      const existingConnectionIndex = connections.findIndex(
        (connection) => connection.id === connectionInfo.id
      );

      const newConnections = [...connections];

      if (existingConnectionIndex !== -1) {
        // Update the existing saved connection.
        newConnections[existingConnectionIndex] = cloneDeep(connectionInfo);
      } else {
        // Add the newly saved connection to our connections list.
        newConnections.push(cloneDeep(connectionInfo));
      }

      if (activeConnectionId === connectionInfo.id) {
        // Update the active connection if it's currently selected.
        dispatch({
          type: 'set-connections-and-select',
          connections: newConnections,
          activeConnectionInfo: cloneDeep(connectionInfo),
        });
        return;
      }

      dispatch({
        type: 'set-connections',
        connections: newConnections,
      });
    },
    setActiveConnectionById(newConnectionId: string) {
      const connection = connections.find(
        (connection) => connection.id === newConnectionId
      );
      if (connection) {
        dispatch({
          type: 'set-active-connection',
          connectionInfo: connection,
        });
      }
    },
    removeConnection(connectionInfo) {
      void removeConnection(connectionInfo);
    },
    duplicateConnection(connectionInfo: ConnectionInfo) {
      const duplicate: ConnectionInfo = {
        ...cloneDeep(connectionInfo),
        id: uuidv4(),
      };
      if (duplicate.favorite?.name) {
        duplicate.favorite.name += ' (copy)';
      }
      saveConnectionInfo(duplicate).then(
        () => {
          dispatch({
            type: 'set-connections-and-select',
            connections: [...connections, duplicate],
            activeConnectionInfo: duplicate,
          });
        },
        () => {
          // We do nothing when if it fails
        }
      );
    },
    async removeAllRecentsConnections() {
      const recentConnections = connections.filter((conn) => {
        return !conn.favorite;
      });
      await Promise.all(
        recentConnections.map((conn) => connectionStorage.delete(conn))
      );
      dispatch({
        type: 'set-connections',
        connections: connections.filter((conn) => {
          return conn.favorite;
        }),
      });
    },
    reloadConnections() {
      void loadConnections(dispatch, connectionStorage);
    },
  };
}
