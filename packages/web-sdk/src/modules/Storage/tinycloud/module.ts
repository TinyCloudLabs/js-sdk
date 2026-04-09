import { tinycloud } from '@tinycloud/web-sdk-wasm';
import type { InvokeFunction } from '@tinycloud/sdk-services';

type TinyCloudModule = typeof tinycloud;
const msg =
  "Has TinyCloud been initialised? 'global.tinycloudModule' is not of the expected type";

function getModule(): TinyCloudModule {
  try {
    return global.tinycloudModule;
  } catch (e) {
    throw `${msg}: ${e}`;
  }
}

export const makeSpaceId: TinyCloudModule['makeSpaceId'] = (...args) => {
  try {
    return Reflect.apply(getModule().makeSpaceId, getModule(), args);
  } catch (e) {
    throw `${msg}: ${e}`;
  }
};

export const prepareSession: TinyCloudModule['prepareSession'] = (...args) => {
  try {
    return Reflect.apply(getModule().prepareSession, getModule(), args);
  } catch (e) {
    throw `${msg}: ${e}`;
  }
};

export const completeSessionSetup: TinyCloudModule['completeSessionSetup'] = (
  ...args
) => {
  try {
    return Reflect.apply(getModule().completeSessionSetup, getModule(), args);
  } catch (e) {
    throw `${msg}: ${e}`;
  }
};

export const invoke: InvokeFunction = (...args) => {
  try {
    return Reflect.apply(getModule().invoke, getModule(), args) as any;
  } catch (e) {
    throw `${msg}: ${e}`;
  }
};

export const invokeAny: TinyCloudModule['invokeAny'] = (...args) => {
  try {
    return Reflect.apply(getModule().invokeAny, getModule(), args) as any;
  } catch (e) {
    throw `${msg}: ${e}`;
  }
};

export const generateHostSIWEMessage: TinyCloudModule['generateHostSIWEMessage'] =
  (...args) => {
    try {
      return Reflect.apply(
        getModule().generateHostSIWEMessage,
        getModule(),
        args
      );
    } catch (e) {
      throw `${msg}: ${e}`;
    }
  };

export const siweToDelegationHeaders: TinyCloudModule['siweToDelegationHeaders'] =
  (...args) => {
    try {
      return Reflect.apply(
        getModule().siweToDelegationHeaders,
        getModule(),
        args
      );
    } catch (e) {
      throw `${msg}: ${e}`;
    }
  };
