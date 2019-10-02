import { fromSnapshot, getSnapshot, model, Model, modelId } from "../../src"
import "../commonSetup"

test("ids", () => {
  @model("ids")
  class M extends Model({}) {}

  // auto generated id
  {
    const m1 = new M({})
    expect(m1.$modelId).toBe("id-1")
    expect(getSnapshot(m1)).toEqual({
      $modelId: "id-1",
      $modelType: "ids",
    })
  }

  // provided id
  {
    const m1 = new M({ [modelId]: "MY_ID" })
    expect(m1.$modelId).toBe("MY_ID")
    expect(getSnapshot(m1)).toEqual({
      $modelId: "MY_ID",
      $modelType: "ids",
    })
  }

  // id on snapshot
  {
    const m1 = fromSnapshot<M>({ $modelType: "ids", $modelId: "MY_ID2" })
    expect(m1.$modelId).toBe("MY_ID2")
    expect(getSnapshot(m1)).toEqual({
      $modelId: "MY_ID2",
      $modelType: "ids",
    })

    const m2 = fromSnapshot<M>(getSnapshot(m1))
    expect(m2.$modelId).toBe("MY_ID2")
    expect(getSnapshot(m2)).toEqual({
      $modelId: "MY_ID2",
      $modelType: "ids",
    })
  }
})