import Helpers from "@camoflage/helpers"
import { RequestHelper } from "./Capture"

export const registerCustomHelpers = (helpers: Helpers) => {
    helpers.addHelper("capture", RequestHelper)
}