/** Arlo types — contrats des captures de caméras Arlo */

/** Camera image ready to be sent (same shape as a Telegram photo). */
export interface CameraPhoto {
    buffer: ArrayBuffer;
    filename: string;
}
