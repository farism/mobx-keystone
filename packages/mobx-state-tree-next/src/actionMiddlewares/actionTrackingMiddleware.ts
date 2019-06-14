import {
  ActionContext,
  ActionContextActionType,
  ActionContextAsyncStepType,
} from "../action/context"
import { ActionMiddleware } from "../action/middleware"
import { Model } from "../model/Model"
import { failure, isObject } from "../utils"

/**
 * Simplified version of action context.
 */
export interface SimpleActionContext {
  /**
   * Action name
   */
  readonly name: string
  /**
   * Action type, sync or async.
   */
  readonly type: ActionContextActionType
  /**
   * Action target object.
   */
  readonly target: object
  /**
   * Array of action arguments.
   */
  readonly args: readonly any[]
  /**
   * Parent action context.
   */
  readonly parentContext?: SimpleActionContext
  /**
   * Custom data for the action context to be set by middlewares, an object.
   */
  readonly data: any
}

/**
 * Action tracking middleware finish result.
 */
export enum ActionTrackingResult {
  Return = "return",
  Throw = "throw",
}

/**
 * Action tracking middleware hooks.
 */
export interface ActionTrackingMiddleware {
  filter?(ctx: SimpleActionContext): boolean
  onStart(ctx: SimpleActionContext): void
  onResume?(ctx: SimpleActionContext): void
  onSuspend?(ctx: SimpleActionContext): void
  onFinish(ctx: SimpleActionContext, result: ActionTrackingResult, value: any): void
}

/**
 * Creates an action tracking middleware, which is a simplified version
 * of the standard action middleware.
 * Note that `filter` is only called for the start of the actions. If the
 * action is accepted then `onStart`, `onResume`, `onSuspend` and `onFinish`
 * for that particular action will be called.
 *
 * @param target Root target model object.
 * @param hooks Middleware hooks.
 * @returns The actual middleware to passed to `addActionMiddleware`.
 */
export function actionTrackingMiddleware<M extends Model>(
  target: {
    model: M
    actionName?: keyof M
  },
  hooks: ActionTrackingMiddleware
): ActionMiddleware {
  if (!isObject(target)) {
    throw failure("target must be an object")
  }

  const { model, actionName } = target

  if (!(model instanceof Model)) {
    throw failure("target must be a model")
  }

  if (actionName && typeof model[actionName] !== "function") {
    throw failure("action must be a function or undefined")
  }

  const dataSymbol = Symbol("actionTrackingMiddlewareData")
  interface Data {
    startAccepted: boolean
    state: "idle" | "started" | "realResumed" | "fakeResumed" | "suspended" | "finished"
  }
  function getCtxData(ctx: ActionContext | SimpleActionContext): Data | undefined {
    return ctx.data[dataSymbol]
  }
  function setCtxData(ctx: ActionContext | SimpleActionContext, partialData: Partial<Data>) {
    let currentData = ctx.data[dataSymbol]
    if (!currentData) {
      ctx.data[dataSymbol] = partialData
    } else {
      Object.assign(currentData, partialData)
    }
  }

  const userFilter: ActionMiddleware["filter"] = ctx => {
    if (hooks.filter) {
      return hooks.filter(simplifyActionContext(ctx))
    }

    return true
  }

  const resumeSuspendSupport = !!hooks.onResume || !!hooks.onSuspend

  const filter: ActionMiddleware["filter"] = ctx => {
    if (actionName && ctx.name !== actionName) {
      return false
    }

    if (ctx.type === ActionContextActionType.Sync) {
      // start and finish is on the same context
      const accepted = userFilter(ctx)
      if (accepted) {
        setCtxData(ctx, {
          startAccepted: true,
          state: "idle",
        })
      }
      return accepted
    } else {
      switch (ctx.asyncStepType) {
        case ActionContextAsyncStepType.Spawn:
          const accepted = userFilter(ctx)
          if (accepted) {
            setCtxData(ctx, {
              startAccepted: true,
              state: "idle",
            })
          }
          return accepted

        case ActionContextAsyncStepType.Return:
        case ActionContextAsyncStepType.Throw:
          // depends if the spawn one was accepted or not
          let previousCtx = ctx
          while (previousCtx.previousAsyncStepContext) {
            previousCtx = previousCtx.previousAsyncStepContext!
          }
          const data = getCtxData(previousCtx)
          return data ? data.startAccepted : false

        case ActionContextAsyncStepType.Resume:
        case ActionContextAsyncStepType.ResumeError:
          return resumeSuspendSupport

        default:
          return false
      }
    }
  }

  const start = (simpleCtx: SimpleActionContext) => {
    setCtxData(simpleCtx, {
      state: "started",
    })
    hooks.onStart(simpleCtx)
  }

  const finish = (simpleCtx: SimpleActionContext, result: ActionTrackingResult, value: any) => {
    // fakely resume and suspend the parent if needed
    const parentCtx = simpleCtx.parentContext
    let parentResumed = false
    if (parentCtx) {
      const parentData = getCtxData(parentCtx)
      if (parentData && parentData.startAccepted && parentData.state === "suspended") {
        parentResumed = true
        resume(parentCtx, false)
      }
    }

    setCtxData(simpleCtx, {
      state: "finished",
    })
    hooks.onFinish(simpleCtx, result, value)

    if (parentResumed) {
      suspend(parentCtx!)
    }
  }

  const resume = (simpleCtx: SimpleActionContext, real: boolean) => {
    // ensure parents are resumed
    const parentCtx = simpleCtx.parentContext
    if (parentCtx) {
      const parentData = getCtxData(parentCtx)
      if (parentData && parentData.startAccepted && parentData.state === "suspended") {
        resume(parentCtx, false)
      }
    }

    setCtxData(simpleCtx, {
      state: real ? "realResumed" : "fakeResumed",
    })
    if (hooks.onResume) {
      hooks.onResume(simpleCtx)
    }
  }

  const suspend = (simpleCtx: SimpleActionContext) => {
    setCtxData(simpleCtx, {
      state: "suspended",
    })
    if (hooks.onSuspend) {
      hooks.onSuspend(simpleCtx)
    }

    // ensure parents are suspended if they were fakely resumed
    const parentCtx = simpleCtx.parentContext
    if (parentCtx) {
      const parentData = getCtxData(parentCtx)
      if (parentData && parentData.startAccepted && parentData.state === "fakeResumed") {
        suspend(parentCtx)
      }
    }
  }

  const mware: ActionMiddleware["middleware"] = (ctx, next) => {
    const simpleCtx = simplifyActionContext(ctx)

    const origNext = next
    next = () => {
      resume(simpleCtx, true)
      try {
        return origNext()
      } finally {
        suspend(simpleCtx)
      }
    }

    if (ctx.type === ActionContextActionType.Sync) {
      start(simpleCtx)

      let ret
      try {
        ret = next()
      } catch (err) {
        finish(simpleCtx, ActionTrackingResult.Throw, err)
        throw err
      }

      finish(simpleCtx, ActionTrackingResult.Return, ret)
      return ret
    } else {
      // async

      switch (ctx.asyncStepType) {
        case ActionContextAsyncStepType.Spawn: {
          start(simpleCtx)
          return next()
        }

        case ActionContextAsyncStepType.Return: {
          const ret = next()
          finish(simpleCtx, ActionTrackingResult.Return, ret)
          return ret
        }

        case ActionContextAsyncStepType.Throw: {
          const ret = next()
          finish(simpleCtx, ActionTrackingResult.Throw, ret)
          return ret
        }

        case ActionContextAsyncStepType.Resume:
        case ActionContextAsyncStepType.ResumeError:
          if (resumeSuspendSupport) {
            return next()
          } else {
            throw failure(
              `asssertion error: async step should have been filtered out - ${ctx.asyncStepType}`
            )
          }

        default:
          throw failure(
            `asssertion error: async step should have been filtered out - ${ctx.asyncStepType}`
          )
      }
    }
  }

  return { middleware: mware, filter, target: model }
}

/**
 * Simplifies an action context by turning an async call hierarchy into a similar sync one.
 *
 * @param ctx
 * @returns
 */
export function simplifyActionContext(ctx: ActionContext): SimpleActionContext {
  while (ctx.previousAsyncStepContext) {
    ctx = ctx.previousAsyncStepContext
  }

  return {
    name: ctx.name,
    type: ctx.type,
    target: ctx.target,
    args: ctx.args,
    data: ctx.data,
    parentContext: ctx.parentContext ? simplifyActionContext(ctx.parentContext) : undefined,
  }
}