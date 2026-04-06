import numpy as np

data = np.load("extracted_dataset/dataset.npz")

# Take 1 sample from test set
xf = data["X_face_test"][0]
xa = data["X_audio_test"][0]
fm = data["face_mask_test"][0]
am = data["audio_mask_test"][0]

# Save files
np.save("xf.npy", xf)
np.save("xa.npy", xa)
np.save("fm.npy", fm)
np.save("am.npy", am)

print("Sample files created")
