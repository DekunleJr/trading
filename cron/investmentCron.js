const cron = require("node-cron");
const User = require("../model/user");

// Run daily at midnight
cron.schedule("0 0 * * *", async () => {
  console.log("Running investment growth check...");

  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1); // Get date 1 month ago

  try {
    const users = await User.find({ investmentDate: { $lte: oneMonthAgo } });

    for (let user of users) {
      user.investmentAmount *= 1.5; // Increase by 1.5x
      user.investmentDate = new Date(); // Reset investment date
      await user.save();
      console.log(`Updated investment for ${user.email}`);
    }
  } catch (error) {
    console.error("Investment update failed:", error);
  }
});
